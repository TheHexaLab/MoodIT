#!/usr/bin/env python3
"""Porte de couverture (#90) : compare la couverture des lignes de chaque service à son seuil.

Lit les rapports déposés par les jobs de tests :
  - Java : <dossier>/<service>/jacocoTestReport.xml   (rapport JaCoCo)
  - frontend : <dossier>/frontend/coverage-summary.json (résumé Vitest v8)
et les seuils de .github/coverage-thresholds.json.

Affiche une ligne verte par service au-dessus de son seuil, rouge sinon (ou si le rapport
manque, par exemple parce que les tests ont échoué), écrit un tableau dans le résumé du job
GitHub et sort en erreur si au moins un service est sous son seuil.

Usage : python coverage-gate.py <dossier des rapports> [fichier des seuils]
Aucune dépendance hors bibliothèque standard : lançable aussi en local.
"""
import json
import os
import sys
import xml.etree.ElementTree as ET

GREEN, RED, BOLD, RESET = "\033[32m", "\033[31m", "\033[1m", "\033[0m"


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


def fmt(value):
    return "—" if value is None else f"{value:.1f} %"


def main():
    reports_dir = sys.argv[1] if len(sys.argv) > 1 else "coverage-reports"
    thresholds_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(__file__), "..", "coverage-thresholds.json")
    with open(thresholds_file, encoding="utf-8") as f:
        thresholds = json.load(f)["services"]

    rows, failures = [], []
    print(f"{BOLD}Couverture des lignes par service (seuils : {os.path.basename(thresholds_file)}){RESET}")
    for service, threshold in thresholds.items():
        result = measure(reports_dir, service)
        if result is None:
            ok, lines, branches = False, None, None
            detail = "rapport absent (tests en échec ou job non exécuté)"
        else:
            lines, branches = result
            ok = lines is not None and lines >= threshold
            detail = f"{fmt(lines)} (seuil {threshold} %, branches {fmt(branches)})"
        color, mark = (GREEN, "✔") if ok else (RED, "✘")
        print(f"{color}{mark} {service:<20} {detail}{RESET}")
        rows.append((ok, service, lines, threshold, branches))
        if not ok:
            failures.append(service)
            # Annotation visible sur la PR, en plus du journal.
            print(f"::error title=Couverture insuffisante::{service} : {detail}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write("## Couverture des tests\n\n| | Service | Lignes | Seuil | Branches |\n|---|---|---|---|---|\n")
            for ok, service, lines, threshold, branches in rows:
                out.write(f"| {'🟢' if ok else '🔴'} | {service} | {fmt(lines)} | {threshold} % | {fmt(branches)} |\n")
            out.write("\n" + ("Tous les services atteignent leur seuil.\n" if not failures
                              else f"Sous le seuil : {', '.join(failures)}.\n"))

    if failures:
        print(f"{RED}{BOLD}✘ {len(failures)} service(s) sous le seuil : {', '.join(failures)}{RESET}")
        return 1
    print(f"{GREEN}{BOLD}✔ Tous les services atteignent leur seuil de couverture.{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
