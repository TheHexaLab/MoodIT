"""Alerte quand un run de CI échoue sur main, deploiement ou la nuit (#113).

Ces runs ne sont vus par personne : l'échec d'un workflow planifié ne notifie que l'auteur du
cron, et les jobs propres à main et à la nuit (Firefox, WebKit, PIT) ne tournent pas sur les PR.

Une issue par couple (workflow, branche), repérée par un marqueur caché dans son corps :
- run en échec, pas d'issue ouverte -> issue créée, avec le lien du run et la liste des jobs rouges
- run en échec, issue déjà ouverte  -> commentaire (nouveau run rouge), sans rouvrir de doublon
- run vert, issue ouverte           -> commentaire puis fermeture
- run annulé ou ignoré              -> rien (ni preuve d'échec, ni preuve de réparation)

Seuls les runs `push` et `schedule` sur main ou deploiement comptent : une PR rouge est déjà vue
par son auteur.

Variables d'environnement : GH_TOKEN (issues en écriture, actions en lecture), REPO (owner/nom),
RUN_ID, ASSIGNEES (logins séparés par des virgules, optionnel), DRY_RUN ("true" : n'écrit rien).
"""
import json
import os
import subprocess
import sys

REPO = os.environ.get("REPO", "TheHexaLab/MoodIT")
RUN_ID = os.environ.get("RUN_ID", "")
ASSIGNEES = [a.strip() for a in os.environ.get("ASSIGNEES", "").split(",") if a.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "").lower() == "true"

LABEL = "ci"
BRANCHES = {"main", "deploiement"}
EVENTS = {"push", "schedule"}
FAILED = {"failure", "timed_out", "startup_failure"}


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


def describe(run):
    """Une ligne : lien du run, évènement, commit."""
    when = "run planifié" if run["event"] == "schedule" else "push"
    return f"[{run['name']} #{run['run_number']}]({run['html_url']}) ({when}, commit `{run['head_sha'][:8]}`)"


def failure_report(run):
    jobs = failed_jobs(run["id"])
    lines = [f"- [{j['name']}]({j['html_url']})" for j in jobs] or ["- (aucun job en échec listé : voir le run)"]
    return "\n".join([f"Run en échec : {describe(run)}", "", "Jobs en échec :", *lines])


def write(args, payload, what):
    if not DRY_RUN:
        print(what)
        return gh(args, payload)
    print(f"{what} (simulation) :\n{payload.get('body', payload)}\n")
    return None


def main():
    if not RUN_ID.isdigit():
        raise RuntimeError(f"RUN_ID invalide : « {RUN_ID} » (identifiant numérique attendu)")
    run = gh([f"repos/{REPO}/actions/runs/{RUN_ID}"])
    workflow, branch, event, conclusion = run["name"], run["head_branch"], run["event"], run["conclusion"]
    print(f"Run {RUN_ID} : {workflow} sur {branch} ({event}) -> {conclusion}")
    if event not in EVENTS or branch not in BRANCHES:
        print("Hors périmètre (seuls push et schedule sur main ou deploiement comptent).")
        return

    mark = marker(workflow, branch)
    issue = find_issue(mark)

    if conclusion in FAILED:
        report = failure_report(run)
        if issue:
            write(["-X", "POST", f"repos/{REPO}/issues/{issue['number']}/comments"],
                  {"body": f"Toujours en échec.\n\n{report}"},
                  f"Commentaire sur #{issue['number']} (nouveau run rouge)")
        else:
            body = "\n\n".join([
                mark,
                report,
                "Cette issue est ouverte automatiquement par le workflow « Alerte CI » (#113). "
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
        write(["-X", "POST", f"repos/{REPO}/issues/{issue['number']}/comments"],
              {"body": f"Run vert : {describe(run)}. Fermeture automatique."},
              f"Commentaire sur #{issue['number']} (run vert)")
        write(["-X", "PATCH", f"repos/{REPO}/issues/{issue['number']}"],
              {"state": "closed", "state_reason": "completed"},
              f"Fermeture de #{issue['number']}")
    else:
        print(f"Conclusion « {conclusion} » : ni échec ni réparation, rien à faire.")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(f"::error::{e}")
        sys.exit(1)
