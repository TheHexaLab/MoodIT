#!/usr/bin/env python3
"""Porte de couverture (#90, #108) : compare la couverture des lignes de chaque service à son
seuil et, sur une PR, à la référence de main (cliquet).

Lit les rapports déposés par les jobs de tests :
  - Java : <dossier>/<service>/jacocoTestReport.xml   (rapport JaCoCo)
  - frontend : <dossier>/frontend/coverage-summary.json (résumé Vitest v8)
et les seuils de .github/coverage-thresholds.json.

Un service est rouge s'il est sous son seuil, si son rapport manque (tests en échec, par exemple)
ou, avec --baseline, si sa couverture baisse de plus de TOLERANCE point par rapport à la
référence de main. Le seuil, arrondi à l'entier, laissait passer une baisse de moins d'un point ;
la référence, elle, suit la progression sans édition manuelle. Un service absent de la référence
(nouveau service, première mesure) n'est comparé qu'à son seuil.

Affiche une ligne par service, écrit un tableau dans le résumé du job GitHub et sort en erreur
si au moins un service est rouge. --write enregistre la couverture mesurée (JSON
{service: % des lignes}) : c'est la future référence quand le job tourne sur main.

Usage : python coverage-gate.py <dossier des rapports> [fichier des seuils]
                                [--baseline référence.json] [--write mesure.json]
Aucune dépendance hors bibliothèque standard : lançable aussi en local.
"""
import argparse
import json
import os
import sys
import xml.etree.ElementTree as ET

GREEN, RED, BOLD, RESET = "\033[32m", "\033[31m", "\033[1m", "\033[0m"

# Baisse tolérée par rapport à main, en points de pourcentage. Absorbe l'arrondi du résumé Vitest
# (deux décimales) ; une vraie baisse, même d'un demi-point, reste rouge.
TOLERANCE = 0.1


def jacoco_coverage(path):
    """(lignes %, branches %) du compteur global d'un rapport JaCoCo."""
    root = ET.parse(path).getroot()
    counters = {c.get("type"): c for c in root.findall("counter")}

    def pct(kind):
        c = counters.get(kind)
        if c is None:
            return None
        covered, missed = int(c.get("covered")), int(c.get("missed"))
        return 100.0 * covered / (covered + missed) if covered + missed else 100.0

    return pct("LINE"), pct("BRANCH")


def vitest_coverage(path):
    """(lignes %, branches %) du total d'un coverage-summary.json (Vitest, provider v8)."""
    with open(path, encoding="utf-8") as f:
        total = json.load(f)["total"]
    return float(total["lines"]["pct"]), float(total["branches"]["pct"])


def measure(reports_dir, service):
    if service == "frontend":
        path = os.path.join(reports_dir, "frontend", "coverage-summary.json")
        return vitest_coverage(path) if os.path.exists(path) else None
    path = os.path.join(reports_dir, service, "jacocoTestReport.xml")
    return jacoco_coverage(path) if os.path.exists(path) else None


def load_baseline(path):
    """Référence de main ({service: %}), ou {} si absente ou illisible (première mesure)."""
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return {k: float(v) for k, v in data.items() if isinstance(v, (int, float))}
    except (OSError, ValueError, AttributeError) as e:
        print(f"::warning title=Référence de couverture illisible::{path} : {e}")
        return {}


def fmt(value):
    return "—" if value is None else f"{value:.1f} %"


def main():
    parser = argparse.ArgumentParser(description="Porte de couverture par service.")
    parser.add_argument("reports_dir", nargs="?", default="coverage-reports")
    parser.add_argument("thresholds_file", nargs="?",
                        default=os.path.join(os.path.dirname(__file__), "..", "coverage-thresholds.json"))
    parser.add_argument("--baseline", help="référence de main à ne pas faire baisser (cliquet)")
    parser.add_argument("--write", help="fichier où enregistrer la couverture mesurée")
    args = parser.parse_args()
    with open(args.thresholds_file, encoding="utf-8") as f:
        thresholds = json.load(f)["services"]
    baseline = load_baseline(args.baseline)
    if args.baseline:
        known = ", ".join(f"{k} {v:.2f} %" for k, v in sorted(baseline.items()))
        print(f"Référence de main : {known or 'aucune (première mesure : seuils seulement)'}")

    rows, failures, measured = [], [], {}
    print(f"{BOLD}Couverture des lignes par service (seuils : {os.path.basename(args.thresholds_file)}){RESET}")
    for service, threshold in thresholds.items():
        result = measure(args.reports_dir, service)
        reference = baseline.get(service)
        if result is None:
            ok, lines, branches = False, None, None
            detail = "rapport absent (tests en échec ou job non exécuté)"
        else:
            lines, branches = result
            measured[service] = round(lines, 3)
            ok = lines is not None and lines >= threshold
            detail = f"{fmt(lines)} (seuil {threshold} %, branches {fmt(branches)})"
            if reference is not None:
                drop = reference - lines
                if drop > TOLERANCE:
                    ok = False
                    detail += f", en baisse de {drop:.2f} point par rapport à main ({reference:.2f} %)"
                else:
                    detail += f", main {reference:.2f} %"
        color, mark = (GREEN, "✔") if ok else (RED, "✘")
        print(f"{color}{mark} {service:<20} {detail}{RESET}")
        rows.append((ok, service, lines, threshold, branches, reference))
        if not ok:
            failures.append(service)
            # Annotation visible sur la PR, en plus du journal.
            print(f"::error title=Couverture insuffisante::{service} : {detail}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write("## Couverture des tests\n\n| | Service | Lignes | main | Seuil | Branches |\n"
                      "|---|---|---|---|---|---|\n")
            for ok, service, lines, threshold, branches, reference in rows:
                out.write(f"| {'🟢' if ok else '🔴'} | {service} | {fmt(lines)} | {fmt(reference)} | "
                          f"{threshold} % | {fmt(branches)} |\n")
            out.write("\n" + ("Tous les services atteignent leur seuil, sans baisse par rapport à main.\n"
                              if not failures else f"En échec : {', '.join(failures)}.\n"))

    if args.write:
        with open(args.write, "w", encoding="utf-8") as out:
            json.dump(measured, out, indent=2, sort_keys=True)

    if failures:
        print(f"{RED}{BOLD}✘ {len(failures)} service(s) en échec : {', '.join(failures)}{RESET}")
        return 1
    print(f"{GREEN}{BOLD}✔ Tous les services atteignent leur seuil de couverture.{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
