#!/usr/bin/env python3
"""Rejoue les harnais des questions compilées contre le noteur booléen des runners (#116).

Le noteur des langages compilés (Java, C, C++, C#, Go, Rust) ne transporte que les entiers,
flottants, booléens et chaînes entre le code de l'étudiant et le harnais. Une question écrite
du temps de Piston, où le harnais était compilé AVEC le code de l'étudiant, peut échanger un
tableau, une structure ou une collection : son harnais ne compile plus, et chaque étudiant
reçoit 0 sur une tentative unique, sans panne visible. Ce script le détecte avant les étudiants.

Pour chaque question compilée qui a des cas, il envoie son CODE DE DÉPART et ses harnais à
l'endpoint interne d'execution-service (le chemin de la correction), puis classe le verdict :

  BLOQUANT    le harnais ne compile pas contre la signature, et le compilateur le dit : la
              question notera 0 à tout le monde ;
  À VÉRIFIER  rien ne prouve que le harnais a tourné : le code de départ ne compile pas seul,
              n'existe pas ou ne déclare aucune fonction aux types transportables (aucune
              fonction du tout, ou seulement des types non transportables : le superviseur ne
              distingue pas les deux), la compilation du harnais a expiré ou a été tuée, le
              compilateur n'a rien dit, le harnais appelle une fonction absente du code de
              départ (squelette à compléter), le noteur n'a pas répondu ou a refusé le format,
              ou le détail n'est pas reconnu : le script ne peut pas conclure, rejouer à la main
              avec une solution (« Tester ») ;
  OK          le harnais a compilé et tourné (qu'il passe ou non contre le code de départ
              incomplet), prouvé par le verdict ou par un détail de la liste blanche HARNESS_RAN.

Les questions INTERPRÉTÉES à mandataires (Python, JavaScript, TypeScript, Bash) sont rejouées
aussi, pour un seul contrôle : depuis #116, une fonction ou une classe que le harnais nomme et
qui porte le nom d'une intégrée du langage (`sum`, `max`, `Number`, `test`…) est REFUSÉE
(« Nom réservé ») — sauf si le CODE DE DÉPART de la question la déclare : c'est alors celle que
l'énoncé impose, notée comme avant (#22). Le code de départ part donc avec la demande, comme
dans la correction. Un refus malgré lui sort BLOQUANT (garde-fou) ; une question sans code de
départ sort À VÉRIFIER : si son énoncé impose un tel nom, lui donner un code de départ qui le
déclare. De même pour un cas dont le harnais n'emploie AUCUN nom déclaré par le code de départ
(gabarit laissé tel quel) : le rejeu ne peut pas voir le refus que recevra l'étudiant. Tout autre
verdict y vaut OK — le format de ces harnais n'a pas changé.

Code de sortie : 0 si aucun BLOQUANT ni À VÉRIFIER, 1 sinon, 2 si l'inventaire est impossible.
Avec --unpublish, les quiz publiés qui portent un BLOQUANT sont fermés (is_published = false),
pour qu'aucun étudiant ne les soumette avant correction ; rien n'est modifié sans cette option.

À lancer sur l'hôte de prod, APRÈS la mise en ligne de cette version (le noteur interrogé doit
être le nouveau) : `python3 deploy/check-compiled-harnesses.py`. Variables d'environnement :
  PG_CONTAINER    conteneur Postgres (défaut moodit_postgres) ;
  EXEC_CONTAINER  conteneur execution-service (défaut moodit_execution) ;
  EXEC_URL        URL d'execution-service, sinon l'IP du conteneur sur son réseau Docker et
                  le port de son EXEC_SERVICE_PORT (8085 par défaut)
                  (joignable depuis un hôte Linux ; sous Docker Desktop, donner EXEC_URL) ;
  INTERNAL_TOKEN  jeton interne, sinon lu dans l'environnement du conteneur execution-service.
Le jeton n'est jamais affiché.
"""

import argparse
import http.client
import json
import os
import re
import subprocess
import sys
import urllib.request

COMPILED_LANGUAGES = ("Java", "C", "C++", "C#", "Go", "Rust")
# Langages interprétés dont le noteur génère un mandataire par symbole soumis, et refuse celui
# qui masque une intégrée (CodeAssembler : assemblePython, assembleJsRpc, assembleBashRpc).
PROXIED_LANGUAGES = ("Python", "JavaScript", "TypeScript", "Bash")
# Début du refus écrit par CodeAssembler (SHADOW_PREFIX), suivi du nom.
RESERVED_NAME = "Nom réservé : « "

# Déclarations que le noteur lit dans un code (mêmes motifs que CodeAssembler : PY_DEF/PY_CLASS,
# JS_CALLABLE/JS_CLASS, BASH_FUNC). Un nom que le code de départ déclare n'est jamais refusé.
_JS_EXPORT = r"(?:export\s+(?:default\s+)?)?"
DECLARATIONS = {
    "Python": (r"(?m)^(?:async\s+)?def\s+([A-Za-z_]\w*)", r"(?m)^class\s+([A-Za-z_]\w*)"),
    "JavaScript": (r"(?m)^" + _JS_EXPORT + r"(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)",
                   r"(?m)^" + _JS_EXPORT + r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=",
                   r"(?m)^" + _JS_EXPORT + r"(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)"),
    "Bash": (r"(?m)^(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)",),
}
DECLARATIONS["TypeScript"] = DECLARATIONS["JavaScript"]


def declared_names(language, start_code):
    """Noms que le code de départ déclare, lus comme le noteur. FONCTION PURE (testée)."""
    names = set()
    for pattern in DECLARATIONS.get(language, ()):
        names.update(re.findall(pattern, start_code or ""))
    return names


def harness_uses_start_code(language, start_code, harness):
    """Le harnais emploie-t-il un nom que le code de départ déclare ? FONCTION PURE (testée).

    Non : le code de départ ne déclare pas la fonction notée (gabarit `def solution()` laissé tel
    quel, ou code de départ vide). Si l'énoncé impose un nom d'intégrée (`max`, `sum`), la réponse
    de l'étudiant sera refusée (« Nom réservé ») sans que le rejeu du code de départ le montre."""
    return any(re.search(r"(?<![\w$])" + re.escape(name) + r"(?![\w$])", harness or "")
               for name in declared_names(language, start_code))

# Préfixes et marqueurs écrits par le superviseur (docker/runners/common/supervisor.py) : le texte
# du compilateur ne vient qu'APRÈS eux, le code soumis ne peut pas les produire.
HARNESS_BUILD_ERROR = "Le harnais ne compile pas"
HARNESS_BUILD_ABORTED = "Le harnais n'a pas fini de compiler"
NO_TRANSPORTABLE_SIGNATURE = "types acceptés"

# Nom introuvable, d'après le diagnostic du compilateur de chaque langage compilé :
#   Java   « symbol:   method carre(int) »        C/C++  « implicit declaration of function ‘f’ »,
#          « symbol:   class Rect »                      « ‘f’ was not declared in this scope »,
#   C#     « does not contain a definition for `F' »,    « undefined reference to `f' »
#          « The name `f' does not exist »         Go     « undefined: F »
#   Rust   « cannot find function `f` in this scope »
# et, pour un MEMBRE ou un type que l'étudiant doit ajouter (squelette à compléter) :
#   Java   « symbol:   constructor Rect(int) »     C/C++  « has no member named ‘aire’ »
#   C#     « The type or namespace name 'Rect' »   Go     « has no field or method Aire »
#   Rust   « no method named `aire` found », « no function or associated item named `new` »,
#          « no field `x` on type », « use of undeclared type `Rect` »
_Q = "[`'‘’\"]"
UNDEFINED_NAME = re.compile(
    r"symbol:\s+(?:method|variable|class|constructor)\s+(\w+)"
    r"|implicit declaration of function " + _Q + r"(\w+)"
    r"|" + _Q + r"(\w+)" + _Q + r" was not declared in this scope"
    r"|undefined reference to " + _Q + r"(\w+)"
    r"|does not contain a definition for " + _Q + r"(\w+)"
    r"|The name " + _Q + r"(\w+)" + _Q + r" does not exist"
    r"|undefined: (\w+)"
    r"|cannot find (?:function|value|struct|type) " + _Q + r"(\w+)"
    r"|has no member named " + _Q + r"(\w+)"
    r"|has no field or method (\w+)"
    r"|The type or namespace name " + _Q + r"(\w+)"
    r"|no (?:method|function or associated item|associated item) named " + _Q + r"(\w+)"
    r"|no field " + _Q + r"(\w+)" + _Q + r" on type"
    r"|use of undeclared type " + _Q + r"(\w+)")


def missing_from_start_code(diagnostic, start_code):
    """Noms que le compilateur ne trouve pas ET que le code de départ ne mentionne pas.
    FONCTION PURE (testée).

    Un nom PRÉSENT dans le code de départ mais introuvable pour le harnais a été écarté par le
    générateur de bouchons (types non transportables) : la question est cassée. Un nom ABSENT
    est une fonction que l'étudiant doit écrire : rien ne prouve que le harnais est faux.

    La présence se lit HORS COMMENTAIRES : `// À écrire : func carre(n int) int` nomme la
    fonction sans la déclarer, et la compter comme présente fermait un quiz au harnais juste."""
    names = {n for match in UNDEFINED_NAME.findall(diagnostic or "") for n in match if n}
    code = without_comments(start_code)
    return sorted(n for n in names if not re.search(r"\b%s\b" % re.escape(n), code))


# Commentaires des six langages compilés : `/* … */` et `// …` jusqu'à la fin de la ligne.
COMMENT = re.compile(r"/\*.*?\*/|//[^\n]*", re.S)


def without_comments(code):
    """Code sans ses commentaires `//` et `/* */`. FONCTION PURE (testée).

    Lecture volontairement simple : un `//` dans une chaîne (« http://… ») coupe la fin de la
    ligne. L'erreur va du bon côté — un nom de moins dans le code de départ donne À VÉRIFIER,
    jamais une fermeture."""
    return COMMENT.sub(" ", code or "")

# Débuts de détail qui PROUVENT que le harnais a compilé et tourné (liste blanche) : le noteur a
# rendu faux, a relayé une exception du harnais, a vu le processus étudiant refuser un appel ou
# se terminer, ou le couple a été interrompu au temps limite (lancé après les compilations).
# Tout autre détail — message du superviseur ou de DockerEvaluator qu'on ne connaît pas encore,
# stderr du code de départ — ne prouve rien : À VÉRIFIER, jamais OK (fail-closed).
HARNESS_RAN = (
    "Le harnais a renvoyé faux",
    "[MOODIT] harnais:",
    "[MOODIT] appel refuse par le code soumis",
    "[MOODIT] processus etudiant termine",
    "Interrompu (temps limite dépassé)",
)

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
""" % ", ".join("'%s'" % name for name in COMPILED_LANGUAGES + PROXIED_LANGUAGES)


def classify(detail, passed, start_code=""):
    """Classe le verdict d'UN cas joué contre le code de départ. FONCTION PURE (testée)."""
    if passed:
        return OK
    text = detail or ""
    if text.startswith(HARNESS_BUILD_ABORTED):
        # Compilation du noteur expirée ou tuée (machine chargée) : pas un diagnostic.
        return TO_CHECK
    if text.startswith(HARNESS_BUILD_ERROR):
        # BLOQUANT seulement sur un vrai diagnostic du compilateur, et pas quand le harnais
        # appelle une fonction que le code de départ ne contient pas (squelette à compléter) :
        # --unpublish ne ferme un quiz que si la preuve est là.
        diagnostic = text.split("\n", 1)[1].strip() if "\n" in text else ""
        if not diagnostic or missing_from_start_code(diagnostic, start_code):
            return TO_CHECK
        return BLOCKING
    if NO_TRANSPORTABLE_SIGNATURE in text:
        # Le superviseur rend le même message quand le code de départ déclare des fonctions aux
        # types non transportables (question insoluble) et quand il n'en déclare AUCUNE
        # (squelette à compléter : le harnais peut être juste). Rien ne prouve que le harnais
        # casse : pas de fermeture automatique du quiz (--unpublish), rejouer à la main.
        return TO_CHECK
    if text.startswith(HARNESS_RAN):
        # Le harnais a compilé et tourné ; il échoue contre un code de départ incomplet, c'est
        # normal.
        return OK
    # Échec de compilation du code de départ, falsification, erreur du noteur, refus du format
    # (package, nom réservé…), stderr du code de départ : rien ne prouve que le harnais tourne.
    return TO_CHECK


def classify_proxied(detail, passed):
    """Classe le verdict d'UN cas d'une question interprétée à mandataires. PURE (testée).

    Un seul contrôle : le refus « Nom réservé », rendu avant toute exécution du harnais. Le code
    de départ partant avec la demande, un nom qu'il déclare n'est jamais refusé : un refus ici
    est un garde-fou (noteur d'une autre version), déterministe, qui vaudrait pour toute réponse
    qui suit l'énoncé."""
    if not passed and RESERVED_NAME in (detail or ""):
        return BLOCKING
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


DEFAULT_EXEC_PORT = 8085


def exec_port(env_lines):
    """Port d'écoute d'execution-service, lu dans l'environnement de son conteneur (lignes
    NOM=valeur de `docker inspect`). FONCTION PURE (testée).

    Le service écoute sur EXEC_SERVICE_PORT (défaut 8085, cf. application.properties). Avec le
    port en dur, un déploiement sur un autre port voyait chaque appel refusé, et toutes les
    questions sortaient « À VÉRIFIER » sans que rien ne désigne la cause."""
    for line in env_lines:
        name, _, value = line.partition("=")
        if name == "EXEC_SERVICE_PORT" and value.strip().isdigit():
            return int(value.strip())
    return DEFAULT_EXEC_PORT


def exec_url(container):
    if os.environ.get("EXEC_URL"):
        return os.environ["EXEC_URL"].rstrip("/")
    ip = run(["docker", "inspect", "-f",
              "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container]).split()
    if not ip:
        raise RuntimeError("IP du conteneur %s introuvable (donner EXEC_URL)" % container)
    env_lines = run(["docker", "inspect", "-f",
                     "{{range .Config.Env}}{{println .}}{{end}}", container]).splitlines()
    return "http://%s:%d" % (ip[0], exec_port(env_lines))


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
        # Comme core à la correction : un nom que le code de départ déclare est celui que
        # l'énoncé impose, et n'est pas refusé comme « Nom réservé » (#22).
        "startCode": question["start_code"],
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
    except (OSError, http.client.HTTPException, ValueError) as e:
        # OSError couvre URLError, le délai dépassé et la connexion coupée PENDANT la lecture de
        # la réponse (ConnectionResetError), HTTPException une réponse tronquée : sans eux le
        # script s'arrêtait là, sans rejouer les questions suivantes ni fermer les quiz bloquants.
        return TO_CHECK, ["le noteur n'a pas répondu : %s" % e]
    lines, statuses = [], []
    if question["language"] in PROXIED_LANGUAGES:
        for case in question["cases"]:
            if not harness_uses_start_code(question["language"], question["start_code"],
                                           case["harnessCode"]):
                statuses.append(TO_CHECK)
                lines.append("cas %s « %s » : le harnais n'emploie aucune fonction du code de "
                             "départ ; si l'énoncé impose un nom d'intégrée (max, sum…), le "
                             "déclarer dans le code de départ" % (case["id"], case["name"]))
    for case, result in zip(question["cases"], results):
        if question["language"] in PROXIED_LANGUAGES:
            status = classify_proxied(result.get("detail"), bool(result.get("passed")))
        else:
            status = classify(result.get("detail"), bool(result.get("passed")),
                              question.get("start_code") or "")
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
    parser.add_argument("--unpublish", action="store_true",
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

    print("%d question(s) à rejouer." % len(questions))
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
        if args.unpublish:
            psql(pg, "UPDATE Quiz SET is_published = false WHERE id IN (%s);" % ids)
            print("Quiz fermés (is_published = false) : %s" % ids)
        else:
            print("Quiz publiés à corriger ou fermer : %s (--unpublish pour les fermer)" % ids)
    return 1 if counts[BLOCKING] or counts[TO_CHECK] else 0


if __name__ == "__main__":
    sys.exit(main())
