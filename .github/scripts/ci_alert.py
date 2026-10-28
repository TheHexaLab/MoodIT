"""Alerte quand un run de CI échoue sur main, deploiement ou la nuit (#113).

Ces runs ne sont vus par personne : l'échec d'un workflow planifié ne notifie que l'auteur du
cron, et les jobs propres à main et à la nuit (Firefox, WebKit, PIT) ne tournent pas sur les PR.

Un échec passager (dépôt de dépendances indisponible, test instable) ne doit pas notifier pour
rien (#172) : à la première tentative en échec, les jobs en échec sont relancés une fois et le
script ATTEND la fin de la relance (au plus WAIT_MINUTES), puis traite son résultat. Il ne compte pas
sur l'évènement workflow_run de la relance : une relance demandée avec le GITHUB_TOKEN pourrait ne
pas en émettre. S'il arrive quand même, la tentative déjà traitée est reconnue et ignorée. Si la
relance ne peut pas être demandée (run trop ancien, par exemple) ou ne finit pas à temps, l'alerte
part tout de suite : un échec n'est jamais passé sous silence.

Une issue par couple (workflow, branche), repérée par un marqueur caché dans son corps :
- 1re tentative en échec             -> relance des jobs en échec, attente, puis cas suivants
- échec après relance, pas d'issue   -> issue créée, avec le lien du run et la liste des jobs rouges
- échec après relance, issue ouverte -> run ajouté au corps de l'issue, sans rouvrir de doublon
- run vert, issue ouverte            -> lien du run vert ajouté au corps et fermeture, en un appel
- run annulé ou ignoré               -> rien (ni preuve d'échec, ni preuve de réparation)
Seules la création et la fermeture d'une issue notifient : modifier son corps ne notifie personne.

Seuls les runs `push` et `schedule` sur main ou deploiement comptent : une PR rouge est déjà vue
par son auteur.

Variables d'environnement : GH_TOKEN (issues et actions en écriture), REPO (owner/nom), RUN_ID,
ASSIGNEES (logins séparés par des virgules, optionnel), DRY_RUN ("true" : n'écrit ni ne relance rien).
"""
import json
import os
import subprocess
import sys
import time

REPO = os.environ.get("REPO", "TheHexaLab/MoodIT")
RUN_ID = os.environ.get("RUN_ID", "")
ASSIGNEES = [a.strip() for a in os.environ.get("ASSIGNEES", "").split(",") if a.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "").lower() == "true"

LABEL = "ci"
BRANCHES = {"main", "deploiement"}
EVENTS = {"push", "schedule"}
FAILED = {"failure", "timed_out", "startup_failure"}
RETRIES = 1  # relances automatiques avant d'alerter : les tentatives 1 à RETRIES sont relancées
WAIT_MINUTES = 120  # attente maximale d'une relance (Tests complet de la nuit compris)
POLL_SECONDS = 60


def gh(args, payload=None):
    p = subprocess.run(["gh", "api", *args] + (["--input", "-"] if payload is not None else []),
                       input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        raise RuntimeError(f"gh api {' '.join(args)} : {p.stderr.strip() or p.stdout.strip()}")
    return json.loads(p.stdout) if p.stdout.strip() else None


def paginate(path):
    """Toutes les pages d'une liste REST (`--paginate --slurp` : un tableau par page)."""
    pages = gh([path, "--paginate", "--slurp"]) or []
    return [item for page in pages for item in (page if isinstance(page, list) else [page])]


def marker(workflow, branch):
    return f"<!-- ci-alert: {workflow} @ {branch} -->"


def find_issue(mark):
    issues = paginate(f"repos/{REPO}/issues?state=open&labels={LABEL}&per_page=100")
    return next((i for i in issues if "pull_request" not in i and mark in (i.get("body") or "")), None)


def failed_jobs(run_id):
    jobs = gh([f"repos/{REPO}/actions/runs/{run_id}/jobs?filter=latest&per_page=100"]) or {}
    return [j for j in jobs.get("jobs", []) if j.get("conclusion") in FAILED]


def attempt_url(run):
    """Lien de la tentative (le lien du run seul montre toujours la dernière)."""
    return f"{run['html_url']}/attempts/{run.get('run_attempt', 1)}"


def describe(run):
    """Une ligne : lien de la tentative, évènement, commit."""
    when = "run planifié" if run["event"] == "schedule" else "push"
    return (f"[{run['name']} #{run['run_number']}, tentative {run.get('run_attempt', 1)}]({attempt_url(run)}) "
            f"({when}, commit `{run['head_sha'][:8]}`)")


def failure_report(run):
    jobs = failed_jobs(run["id"])
    lines = [f"- [{j['name']}]({j['html_url']})" for j in jobs] or ["- (aucun job en échec listé : voir le run)"]
    return "\n".join([f"Run en échec : {describe(run)}", "", "Jobs en échec :", *lines])


def with_history(issue, line):
    """Corps de l'issue suivi d'une ligne d'historique (modifier le corps ne notifie personne)."""
    body = (issue.get("body") or "").rstrip()
    if "### Historique" not in body:
        body += "\n\n### Historique\n"
    return f"{body}\n- {line}"


def write(args, payload, what):
    if not DRY_RUN:
        print(what)
        return gh(args, payload)
    print(f"{what} (simulation) :\n{payload.get('body', payload)}\n")
    return None


def retry(run):
    """Relance les jobs en échec et renvoie le run une fois la relance finie ; None en simulation.

    Relance impossible ou trop longue : renvoie le run tel quel, l'alerte part sur son échec.
    """
    attempt = run.get("run_attempt", 1)
    try:
        write(["-X", "POST", f"repos/{REPO}/actions/runs/{run['id']}/rerun-failed-jobs"], {},
              f"Tentative {attempt} en échec : relance des jobs en échec avant d'alerter")
    except RuntimeError as e:
        print(f"::warning::Relance impossible, alerte immédiate : {e}")
        return run
    if DRY_RUN:
        return None
    deadline = time.monotonic() + WAIT_MINUTES * 60
    while time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)
        current = gh([f"repos/{REPO}/actions/runs/{run['id']}"])
        if current.get("run_attempt", 1) > attempt and current["status"] == "completed":
            print(f"Relance finie (tentative {current['run_attempt']}) -> {current['conclusion']}")
            return current
    print(f"::warning::Relance non finie après {WAIT_MINUTES} min, alerte sur la tentative {attempt}")
    return run


def main():
    if not RUN_ID.isdigit():
        raise RuntimeError(f"RUN_ID invalide : « {RUN_ID} » (identifiant numérique attendu)")
    run = gh([f"repos/{REPO}/actions/runs/{RUN_ID}"])
    workflow, branch, event, conclusion = run["name"], run["head_branch"], run["event"], run["conclusion"]
    attempt = run.get("run_attempt", 1)
    print(f"Run {RUN_ID} (tentative {attempt}) : {workflow} sur {branch} ({event}) -> {conclusion}")
    if event not in EVENTS or branch not in BRANCHES:
        print("Hors périmètre (seuls push et schedule sur main ou deploiement comptent).")
        return

    if conclusion in FAILED and attempt <= RETRIES:
        run = retry(run)
        if run is None:
            print("Simulation : le résultat de la relance serait traité ici.")
            return
        conclusion = run["conclusion"]

    mark = marker(workflow, branch)
    issue = find_issue(mark)

    # Tentative déjà traitée (évènement workflow_run d'une relance attendue plus haut) : rien.
    if issue and attempt_url(run) in (issue.get("body") or ""):
        print(f"Tentative déjà consignée dans #{issue['number']} : rien à faire.")
        return

    if conclusion in FAILED and issue:
        jobs = ", ".join(j["name"] for j in failed_jobs(run["id"])) or "voir le run"
        write(["-X", "PATCH", f"repos/{REPO}/issues/{issue['number']}"],
              {"body": with_history(issue, f"Toujours en échec : {describe(run)} ; jobs : {jobs}")},
              f"Run ajouté à #{issue['number']} (toujours en échec)")
    elif conclusion in FAILED:
        body = "\n\n".join([
            mark,
            failure_report(run),
            "Cette issue est ouverte automatiquement par le workflow « Alerte CI » (#113), après une "
            "relance automatique elle aussi en échec (#172). "
            f"Elle se ferme toute seule au prochain run vert de « {workflow} » sur `{branch}`. "
            "Un test instable se corrige ici aussi : relancer le job ne suffit pas à long terme.",
        ])
        payload = {"title": f"CI en échec : {workflow} sur {branch}", "body": body, "labels": [LABEL]}
        if ASSIGNEES:
            payload["assignees"] = ASSIGNEES
        created = write(["-X", "POST", f"repos/{REPO}/issues"], payload,
                        f"Création de l'issue « {payload['title']} »")
        if created:
            print(f"Issue #{created['number']} : {created['html_url']}")
    elif conclusion == "success":
        if not issue:
            print("Run vert, aucune issue ouverte : rien à faire.")
            return
        # Un seul appel, donc une seule notification : la fermeture.
        write(["-X", "PATCH", f"repos/{REPO}/issues/{issue['number']}"],
              {"body": with_history(issue, f"Run vert : {describe(run)}. Fermeture automatique."),
               "state": "closed", "state_reason": "completed"},
              f"Fermeture de #{issue['number']} (run vert)")
    else:
        print(f"Conclusion « {conclusion} » : ni échec ni réparation, rien à faire.")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(f"::error::{e}")
        sys.exit(1)
