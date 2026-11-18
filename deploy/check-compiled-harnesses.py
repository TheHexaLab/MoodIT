#!/usr/bin/env python3
"""Rejoue les harnais des questions compilées contre le noteur booléen des runners (#116).

Le noteur des langages compilés (Java, C, C++, C#, Go, Rust) ne transporte que les entiers,
flottants, booléens et chaînes entre le code de l'étudiant et le harnais. Une question écrite
du temps de Piston, où le harnais était compilé AVEC le code de l'étudiant, peut échanger un
tableau, une structure ou une collection : son harnais ne compile plus, et chaque étudiant
reçoit 0 sur une tentative unique, sans panne visible. Ce script le détecte avant les étudiants.

Pour chaque question compilée qui a des cas, il envoie son CODE DE DÉPART et ses harnais à
l'endpoint interne d'execution-service (le chemin de la correction), puis classe le verdict :

  BLOQUANT    le harnais ne compile pas contre la signature, ou la signature du code de
              départ n'utilise aucun type transportable : la question notera 0 à tout le monde ;
  À VÉRIFIER  le code de départ ne compile pas seul, n'existe pas, ou le noteur n'a pas répondu :
              le script ne peut pas conclure, rejouer à la main avec une solution (« Tester ») ;
  OK          le harnais compile (qu'il passe ou non contre le code de départ incomplet).

Code de sortie : 0 si aucun BLOQUANT ni À VÉRIFIER, 1 sinon, 2 si l'inventaire est impossible.
Avec --depublier, les quiz publiés qui portent un BLOQUANT sont fermés (is_published = false),
pour qu'aucun étudiant ne les soumette avant correction ; rien n'est modifié sans cette option.

À lancer sur l'hôte de prod, APRÈS la mise en ligne de cette version (le noteur interrogé doit
être le nouveau) : `python3 deploy/check-compiled-harnesses.py`. Variables d'environnement :
  PG_CONTAINER    conteneur Postgres (défaut moodit_postgres) ;
  EXEC_CONTAINER  conteneur execution-service (défaut moodit_execution) ;
  EXEC_URL        URL d'execution-service, sinon l'IP du conteneur sur son réseau Docker
                  (joignable depuis un hôte Linux ; sous Docker Desktop, donner EXEC_URL) ;
  INTERNAL_TOKEN  jeton interne, sinon lu dans l'environnement du conteneur execution-service.
Le jeton n'est jamais affiché.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

COMPILED_LANGUAGES = ("Java", "C", "C++", "C#", "Go", "Rust")

# Préfixes et marqueurs écrits par le superviseur (docker/runners/common/supervisor.py) : le texte
# du compilateur ne vient qu'APRÈS eux, le code soumis ne peut pas les produire.
HARNESS_BUILD_ERROR = "Le harnais ne compile pas"
NO_TRANSPORTABLE_SIGNATURE = "types acceptés"
OWN_BUILD_ERROR = "Échec de compilation"
TAMPERING = "⚠ Incohérence"   # posé par DockerEvaluator : verdict non fiable, rien à conclure

BLOCKING = "BLOQUANT"
TO_CHECK = "À VÉRIFIER"
OK = "OK"

# Même borne que core (ExecutionClient) : un temps limite plus long n'est jamais demandé.
MAX_TIMEOUT_MS = 60_000

INVENTORY_SQL = """
SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
  SELECT qz.id AS quiz_id, qz.title AS quiz_title, qz.is_published AS published,
         q.id AS question_id, l.name AS language, q.start_code, q.exec_timeout_ms,
         (SELECT json_agg(json_build_object('id', tc.id, 'name', tc.name,
                                            'harnessCode', tc.harness_code,
                                            'weight', tc.weight) ORDER BY tc.id)
            FROM Test_Case tc WHERE tc.question_id = q.id) AS cases
  FROM Question q
  JOIN Language l ON l.id = q.language_id
  JOIN Quiz qz ON qz.id = q.quiz_id
  WHERE l.name IN (%s)
    AND EXISTS (SELECT 1 FROM Test_Case tc WHERE tc.question_id = q.id)
  ORDER BY qz.is_published DESC, qz.id, q.id
) t;
""" % ", ".join("'%s'" % name for name in COMPILED_LANGUAGES)


def classify(detail, passed):
    """Classe le verdict d'UN cas joué contre le code de départ. FONCTION PURE (testée)."""
    if passed:
        return OK
    text = detail or ""
    if text.startswith(HARNESS_BUILD_ERROR) or NO_TRANSPORTABLE_SIGNATURE in text:
        return BLOCKING
    if text.startswith(OWN_BUILD_ERROR) or text.startswith(TAMPERING):
        return TO_CHECK
    # Le harnais a compilé et tourné ; il échoue contre un code de départ incomplet, c'est normal.
    return OK


def worst(statuses):
    """Statut d'une question : le pire de ses cas. FONCTION PURE (testée)."""
    for status in (BLOCKING, TO_CHECK):
        if status in statuses:
            return status
    return OK


def run(command, stdin=None):
    return subprocess.run(command, input=stdin, capture_output=True, text=True,
                          encoding="utf-8", check=True).stdout


def psql(container, sql):
    return run(["docker", "exec", "-i", container, "sh", "-c",
                'psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
               stdin=sql)


def exec_url(container):
    if os.environ.get("EXEC_URL"):
        return os.environ["EXEC_URL"].rstrip("/")
    ip = run(["docker", "inspect", "-f",
              "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container]).split()
    if not ip:
        raise RuntimeError("IP du conteneur %s introuvable (donner EXEC_URL)" % container)
    return "http://%s:8085" % ip[0]


def internal_token(container):
    token = os.environ.get("INTERNAL_TOKEN") or run(
        ["docker", "exec", container, "printenv", "INTERNAL_TOKEN"]).strip()
    if not token:
        raise RuntimeError("INTERNAL_TOKEN introuvable")
    return token


def evaluate(base_url, token, question):
    body = {
        "language": question["language"],
        "code": question["start_code"],
        "testCases": [{"name": c["name"], "harnessCode": c["harnessCode"],
                       "weight": c["weight"]} for c in question["cases"]],
    }
    timeout_ms = question.get("exec_timeout_ms")
    if timeout_ms and timeout_ms > 0:
        body["timeoutMs"] = min(timeout_ms, MAX_TIMEOUT_MS)
    request = urllib.request.Request(
        base_url + "/internal/exec/evaluate", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Internal-Token": token}, method="POST")
    # Une correction compilée peut tenir plusieurs minutes (compilations + attente d'une place).
    with urllib.request.urlopen(request, timeout=900) as response:
        return json.loads(response.read().decode("utf-8"))


def check_question(base_url, token, question):
    """(statut, lignes de détail) d'une question."""
    if not (question.get("start_code") or "").strip():
        return TO_CHECK, ["pas de code de départ : rejouer à la main avec une solution"]
    try:
        results = evaluate(base_url, token, question)
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        return TO_CHECK, ["le noteur n'a pas répondu : %s" % e]
    lines, statuses = [], []
    for case, result in zip(question["cases"], results):
        status = classify(result.get("detail"), bool(result.get("passed")))
        statuses.append(status)
        if status != OK:
            first_line = (result.get("detail") or "").strip().splitlines()[:1]
            lines.append("cas %s « %s » : %s" % (case["id"], case["name"],
                                                 first_line[0] if first_line else status))
    if len(results) != len(question["cases"]):
        statuses.append(TO_CHECK)
        lines.append("%d verdict(s) pour %d cas" % (len(results), len(question["cases"])))
    return worst(statuses), lines


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--depublier", action="store_true",
                        help="fermer les quiz publiés qui portent une question BLOQUANT")
    args = parser.parse_args()
    pg = os.environ.get("PG_CONTAINER", "moodit_postgres")
    ex = os.environ.get("EXEC_CONTAINER", "moodit_execution")
    try:
        questions = json.loads(psql(pg, INVENTORY_SQL).strip() or "[]")
        base_url = exec_url(ex)
        token = internal_token(ex)
    except (subprocess.CalledProcessError, RuntimeError, ValueError) as e:
        print("Inventaire impossible : %s" % e, file=sys.stderr)
        return 2

    print("%d question(s) compilée(s) à rejouer." % len(questions))
    counts = {BLOCKING: 0, TO_CHECK: 0, OK: 0}
    blocked_published = set()
    for question in questions:
        status, lines = check_question(base_url, token, question)
        counts[status] += 1
        print("[%s] quiz %s « %s »%s, question %s (%s)" % (
            status, question["quiz_id"], question["quiz_title"],
            " (publié)" if question["published"] else "", question["question_id"],
            question["language"]))
        for line in lines:
            print("    " + line)
        if status == BLOCKING and question["published"]:
            blocked_published.add(int(question["quiz_id"]))

    print("\nBilan : %d bloquant(s), %d à vérifier, %d ok." % (
        counts[BLOCKING], counts[TO_CHECK], counts[OK]))
    if blocked_published:
        ids = ", ".join(str(i) for i in sorted(blocked_published))
        if args.depublier:
            psql(pg, "UPDATE Quiz SET is_published = false WHERE id IN (%s);" % ids)
            print("Quiz fermés (is_published = false) : %s" % ids)
        else:
            print("Quiz publiés à corriger ou fermer : %s (--depublier pour les fermer)" % ids)
    return 1 if counts[BLOCKING] or counts[TO_CHECK] else 0


if __name__ == "__main__":
    sys.exit(main())
