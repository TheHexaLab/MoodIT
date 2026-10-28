#!/usr/bin/env python3
"""Couverture du code modifié par une PR (#108).

La moyenne d'un service peut rester au-dessus de son seuil alors qu'une PR ajoute du code jamais
exécuté par les tests. Ce script ne regarde que les lignes ajoutées ou modifiées (diff entre deux
révisions) et exige qu'au moins `changed_lines` % d'entre elles soient couvertes
(.github/coverage-thresholds.json).

Lignes prises en compte :
  - Java : <service>/src/main/java/**.java, lues dans <dossier>/<service>/jacocoTestReport.xml
    (une ligne est couverte si au moins une de ses instructions a été exécutée) ;
  - frontend : frontend/src/**.ts(x), lues dans <dossier>/frontend/lcov.info (Vitest).
Une ligne absente du rapport (commentaire, déclaration, import, fichier exclu de la mesure comme
les tests ou les mocks) n'est pas « couvrable » et ne compte pas. Une PR sans ligne couvrable
(docs, config, tests seuls) passe.

Sur une PR, GitHub Actions extrait le commit de fusion : HEAD^1 est la pointe de main et HEAD le
code testé. Le diff HEAD^1..HEAD est donc exactement ce que la PR apporte à main.

Les lignes non couvertes sont listées (fichier, lignes) dans le journal et le résumé du job, et
annotées sur la PR. Sort en erreur sous le seuil, ou si le rapport d'un service modifié manque.

Usage : python coverage-changed.py <dossier des rapports> [fichier des seuils] [--base REV] [--head REV]
Aucune dépendance hors bibliothèque standard : lançable aussi en local.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

GREEN, RED, YELLOW, BOLD, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[0m"
JAVA_SOURCE = re.compile(r"^(?P<service>[\w-]+)/src/main/java/(?P<path>.+\.java)$")
FRONTEND_SOURCE = re.compile(r"^frontend/(?P<path>src/.+\.tsx?)$")
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(?P<start>\d+)(?:,(?P<count>\d+))? @@")
MAX_ANNOTATIONS = 10  # GitHub n'affiche que les 10 premières annotations d'erreur d'une étape


def changed_lines(base, head):
    """{fichier: {lignes ajoutées ou modifiées}} entre deux révisions (numéros côté `head`)."""
    out = subprocess.run(
        ["git", "diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", base, head, "--",
         "*.java", "*.ts", "*.tsx"],
        capture_output=True, text=True, encoding="utf-8", check=True).stdout
    files, current = {}, None
    for line in out.splitlines():
        if line.startswith("+++ "):
            current = None if line == "+++ /dev/null" else line[6:]  # « +++ b/chemin »
        elif current and (m := HUNK.match(line)):
            start, count = int(m["start"]), int(m["count"] if m["count"] is not None else 1)
            files.setdefault(current, set()).update(range(start, start + count))
    return {f: lines for f, lines in files.items() if lines}


def jacoco_lines(path):
    """{"pkg/Fichier.java": {ligne: couverte ?}} d'un rapport JaCoCo."""
    result = {}
    for package in ET.parse(path).getroot().iter("package"):
        for source in package.findall("sourcefile"):
            key = f"{package.get('name')}/{source.get('name')}"
            result[key] = {int(l.get("nr")): int(l.get("ci")) > 0 for l in source.findall("line")}
    return result


def frontend_key(sf):
    """Chemin d'un SF: de lcov ramené à « src/… » (relatif, Windows ou absolu selon la machine)."""
    sf = sf.replace("\\", "/")
    if sf.startswith("src/"):
        return sf
    idx = sf.find("/frontend/src/")
    if idx >= 0:
        return sf[idx + len("/frontend/"):]
    idx = sf.find("/src/")
    return sf[idx + 1:] if idx >= 0 else sf


def lcov_lines(path):
    """{"src/…/fichier.ts": {ligne: couverte ?}} d'un lcov.info, chemins ramenés à src/…"""
    result, current = {}, None
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line.startswith("SF:"):
                current = result.setdefault(frontend_key(line[3:]), {})
            elif line.startswith("DA:") and current is not None:
                nr, hits = line[3:].split(",")[:2]
                current[int(nr)] = current.get(int(nr), False) or int(hits) > 0
            elif line == "end_of_record":
                current = None
    return result


def ranges(numbers):
    """[3, 4, 5, 9] -> [(3, 5), (9, 9)]"""
    out = []
    for n in sorted(numbers):
        if out and n == out[-1][1] + 1:
            out[-1] = (out[-1][0], n)
        else:
            out.append((n, n))
    return out


def fmt_ranges(rs):
    return ", ".join(str(a) if a == b else f"{a}-{b}" for a, b in rs)


def main():
    parser = argparse.ArgumentParser(description="Couverture des lignes modifiées par une PR.")
    parser.add_argument("reports_dir", nargs="?", default="coverage-reports")
    parser.add_argument("thresholds_file", nargs="?",
                        default=os.path.join(os.path.dirname(__file__), "..", "coverage-thresholds.json"))
    parser.add_argument("--base", default="HEAD^1", help="révision de départ (défaut : HEAD^1, la pointe de main)")
    parser.add_argument("--head", default="HEAD", help="révision testée (défaut : HEAD)")
    args = parser.parse_args()
    with open(args.thresholds_file, encoding="utf-8") as f:
        config = json.load(f)
    threshold, services = float(config["changed_lines"]), set(config["services"])

    reports, missing = {}, set()

    def report_for(service):
        if service in reports or service in missing:
            return reports.get(service)
        if service == "frontend":
            path, reader = os.path.join(args.reports_dir, "frontend", "lcov.info"), lcov_lines
        else:
            path, reader = os.path.join(args.reports_dir, service, "jacocoTestReport.xml"), jacoco_lines
        if os.path.exists(path):
            reports[service] = reader(path)
        else:
            missing.add(service)
        return reports.get(service)

    # (service, fichier du dépôt, lignes couvrables modifiées, lignes non couvertes)
    results = []
    for file, lines in sorted(changed_lines(args.base, args.head).items()):
        if m := JAVA_SOURCE.match(file):
            # Clé JaCoCo : package/Fichier.java, soit le chemin sous src/main/java.
            service, key = m["service"], m["path"]
        elif m := FRONTEND_SOURCE.match(file):
            service, key = "frontend", m["path"]
        else:
            continue
        if service not in services:
            continue
        report = report_for(service)
        if report is None:
            continue
        measured = report.get(key, {})
        coverable = sorted(n for n in lines if n in measured)
        if coverable:
            results.append((service, file, coverable, [n for n in coverable if not measured[n]]))

    total = sum(len(c) for _, _, c, _ in results)
    uncovered = sum(len(u) for _, _, _, u in results)
    covered = total - uncovered
    pct = 100.0 * covered / total if total else 100.0
    ok = pct >= threshold and not missing

    print(f"{BOLD}Couverture des lignes modifiées ({args.base}..{args.head}, seuil {threshold:g} %){RESET}")
    for service in sorted(missing):
        print(f"{RED}✘ {service} : rapport de couverture absent, lignes modifiées non vérifiables{RESET}")
        print(f"::error title=Couverture du code modifié::{service} : rapport absent (tests en échec ?)")
    if not total:
        print(f"{GREEN}✔ Aucune ligne de code couvrable modifiée.{RESET}")
    for service, file, coverable, missed in results:
        mark, color = ("✔", GREEN) if not missed else ("✘", RED if not ok else YELLOW)
        detail = f"{len(coverable) - len(missed)}/{len(coverable)} lignes couvertes"
        if missed:
            detail += f", non couvertes : {fmt_ranges(ranges(missed))}"
        print(f"{color}{mark} {file} : {detail}{RESET}")

    # Annotations sur la PR : erreur si le seuil n'est pas atteint, simple avertissement sinon.
    level = "error" if not ok else "warning"
    annotations = [(file, a, b) for _, file, _, missed in results for a, b in ranges(missed)]
    for file, a, b in annotations[:MAX_ANNOTATIONS]:
        what = f"Ligne {a}" if a == b else f"Lignes {a} à {b}"
        print(f"::{level} file={file},line={a},endLine={b},title=Code non couvert::"
              f"{what} : jamais exécutée(s) par les tests")
    if len(annotations) > MAX_ANNOTATIONS:
        print(f"(…{len(annotations) - MAX_ANNOTATIONS} autre(s) plage(s) non annotée(s) : voir la liste ci-dessus)")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write(f"## Couverture du code modifié\n\n{'🟢' if ok else '🔴'} **{covered}/{total} "
                      f"lignes couvertes ({pct:.1f} %)**, seuil {threshold:g} %.\n\n")
            if missing:
                out.write(f"Rapport absent : {', '.join(sorted(missing))}.\n\n")
            if results:
                out.write("| | Fichier | Couvertes | Non couvertes |\n|---|---|---|---|\n")
                for _, file, coverable, missed in results:
                    out.write(f"| {'🟢' if not missed else '🔴'} | `{file}` | "
                              f"{len(coverable) - len(missed)}/{len(coverable)} | "
                              f"{fmt_ranges(ranges(missed)) or '—'} |\n")
            elif not missing:
                out.write("Aucune ligne de code couvrable modifiée.\n")

    if ok:
        print(f"{GREEN}{BOLD}✔ Code modifié : {covered}/{total} lignes couvertes ({pct:.1f} %).{RESET}")
        return 0
    reasons = []
    if total:
        reasons.append(f"{covered}/{total} lignes couvertes ({pct:.1f} %, seuil {threshold:g} %)")
    if missing:
        reasons.append(f"rapport absent pour {', '.join(sorted(missing))}")
    print(f"{RED}{BOLD}✘ Code modifié : {' ; '.join(reasons)}.{RESET}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
