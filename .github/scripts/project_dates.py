"""Remplit Start date / Target date des issues selon leur statut dans le Kanban.

- Statut « In progress », « In review » ou « Done » et Start date vide  -> Start date = aujourd'hui
- Statut « Done » et Target date vide                                   -> Target date = aujourd'hui
- Statut « In progress » ou « In review » et Target date remplie        -> Target date effacée
  (la tâche a été rouverte : elle n'est plus finie)

Les dates sont celles de Sherbrooke (America/Toronto). Le script tourne toutes les 30 minutes, donc la date
enregistrée est celle du passage de la vérification qui suit le changement de statut.

Variables d'environnement : GH_TOKEN (jeton avec accès en lecture au projet et en écriture aux issues),
ORG, PROJECT_NUMBER, REPO (owner/nom), DRY_RUN (optionnel, "true" pour ne rien écrire).
"""
import datetime
import json
import os
import subprocess
import sys
from zoneinfo import ZoneInfo

ORG = os.environ.get("ORG", "TheHexaLab")
PROJECT_NUMBER = int(os.environ.get("PROJECT_NUMBER", "1"))
REPO = os.environ.get("REPO", "TheHexaLab/MoodIT")
DRY_RUN = os.environ.get("DRY_RUN", "").lower() == "true"

START_FIELD_ID = 42766832   # champ d'issue « Start date » (organisation TheHexaLab)
TARGET_FIELD_ID = 42766833  # champ d'issue « Target date »

STARTED = {"In progress", "In review", "Done"}
REOPENED = {"In progress", "In review"}
DONE = "Done"

QUERY = """
query($org: String!, $num: Int!, $cursor: String) {
  organization(login: $org) {
    projectV2(number: $num) {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            ... on Issue { number repository { nameWithOwner } }
          }
        }
      }
    }
  }
}
"""


def gh(args, payload=None):
    p = subprocess.run(["gh", "api", *args] + (["--input", "-"] if payload is not None else []),
                       input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True)
    if p.returncode != 0:
        what = "graphql (lecture du projet)" if args[0] == "graphql" else " ".join(a for a in args if not a.startswith("query="))
        raise RuntimeError(f"gh api {what} : {p.stderr.strip() or p.stdout.strip()}")
    return json.loads(p.stdout) if p.stdout.strip() else None


def project_items():
    cursor = None
    while True:
        args = ["graphql", "-f", f"query={QUERY}", "-f", f"org={ORG}", "-F", f"num={PROJECT_NUMBER}"]
        if cursor:
            args += ["-f", f"cursor={cursor}"]
        data = gh(args)
        items = data["data"]["organization"]["projectV2"]["items"]
        for node in items["nodes"]:
            content = node.get("content") or {}
            if content.get("repository", {}).get("nameWithOwner", "").lower() != REPO.lower():
                continue  # brouillons, PR ou issues d'un autre dépôt
            status = (node.get("status") or {}).get("name")
            yield content["number"], status
        if not items["pageInfo"]["hasNextPage"]:
            break
        cursor = items["pageInfo"]["endCursor"]


def main():
    today = datetime.datetime.now(ZoneInfo("America/Toronto")).date().isoformat()
    changes = 0
    seen = {}
    for number, status in project_items():
        seen[status] = seen.get(status, 0) + 1
        if status not in STARTED:
            continue
        values = gh([f"repos/{REPO}/issues/{number}/issue-field-values", "-X", "GET", "-f", "per_page=100"]) or []
        current = {v["issue_field_id"]: v.get("value") for v in values}
        to_set = []
        if START_FIELD_ID not in current:
            to_set.append({"field_id": START_FIELD_ID, "value": today})
        if status == DONE and TARGET_FIELD_ID not in current:
            to_set.append({"field_id": TARGET_FIELD_ID, "value": today})
        clear_target = status in REOPENED and TARGET_FIELD_ID in current

        if to_set:
            names = ", ".join("Start date" if v["field_id"] == START_FIELD_ID else "Target date" for v in to_set)
            print(f"#{number} [{status}] {names} = {today}")
            if not DRY_RUN:
                gh(["-X", "POST", f"repos/{REPO}/issues/{number}/issue-field-values"],
                   {"issue_field_values": to_set})
            changes += 1
        if clear_target:
            print(f"#{number} [{status}] Target date effacée (tâche rouverte)")
            if not DRY_RUN:
                gh(["-X", "DELETE", f"repos/{REPO}/issues/{number}/issue-field-values/{TARGET_FIELD_ID}"])
            changes += 1
    print("Issues lues par statut : " + ", ".join(f"{k or 'sans statut'}={v}" for k, v in sorted(seen.items(), key=lambda kv: str(kv[0]))))
    print(f"{changes} modification(s){' (simulation)' if DRY_RUN else ''}.")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(f"::error::{e}")
        sys.exit(1)
