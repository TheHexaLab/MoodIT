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
              distingue pas les deux), la compilation du harnais ou un outil de la notation
              (inventaire javap, javac du serveur RPC Java, sonde des noms réservés) a expiré
              ou a été tué, le compilateur n'a rien dit, le harnais appelle une fonction absente du code de
              départ (squelette à compléter), le noteur a refusé le format ou n'a rendu aucun
              verdict, ou le détail n'est pas reconnu : le script ne peut pas conclure, rejouer
              à la main avec une solution (« Tester ») ;
  NOTEUR INDISPONIBLE
              le noteur n'a pas répondu (saturé, injoignable, réponse coupée, jeton refusé),
              même après 2 min de nouveaux essais : rien n'est su de la question, son quiz n'est
              jamais fermé pour ce motif ; relancer le script ;
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

Un harnais compilé qui teste une EXCEPTION du code soumis (catch, assertThrows, catch_unwind…)
sort À VÉRIFIER : le noteur séparé n'en reçoit pas le type, toute bonne réponse échouerait.

Code de sortie : 0 si aucun quiz PUBLIÉ ne porte de question BLOQUANT ou À VÉRIFIER non
acquittée, 1 sinon, 2 si l'inventaire est impossible ou VIDE (--allow-empty pour accepter une
base sans aucune question), 3 si une question au moins est restée sans réponse du noteur
(contrôle incomplet, à relancer ; les quiz prouvés en cause sont fermés quand même avec
--unpublish). Une question d'un quiz NON publié (brouillon, quiz fermé) est listée
sans bloquer : aucun étudiant ne peut la soumettre, et la corriger avant de (ré)ouvrir le quiz
revient à son enseignant. Corriger ou fermer un quiz publié règlent donc tous deux la sortie.
Avec --unpublish, les quiz publiés qui portent un BLOQUANT ou un À VÉRIFIER non acquitté sont
fermés (is_published = false), pour qu'aucun étudiant ne les soumette avant correction ou
vérification ; rien n'est modifié sans cette option.

Deux temps (deploy/DEPLOY.md, « Changement de schéma ») : (1) AVANT la mise en prod, obligatoire,
contre execution-service de CETTE version lancé en local et une base jetable chargée d'un dump
FRAIS de la prod (PG_CONTAINER, EXEC_URL) ; (2) juste APRÈS la mise en ligne, sur l'hôte de prod,
contre le nouveau noteur, avec --unpublish. Une question À VÉRIFIER rejouée à la main avec une
solution s'acquitte par --ack (ids séparés par des virgules), à repasser à l'étape 2. Variables d'environnement :
  PG_CONTAINER    conteneur Postgres (défaut moodit_postgres) ;
  EXEC_CONTAINER  conteneur execution-service (défaut moodit_execution) ;
  EXEC_URL        URL d'execution-service, sinon l'IP du conteneur sur son réseau Docker et
                  le port de son EXEC_SERVICE_PORT (8085 par défaut)
                  (joignable depuis un hôte Linux ; sous Docker Desktop, donner EXEC_URL) ;
  INTERNAL_TOKEN  jeton interne, sinon lu dans l'environnement du conteneur execution-service ;
  EXEC_INTERNAL_QUEUE_WAIT_MS, EXEC_INTERPRETED_BUDGET_MS
                  lus d'abord dans l'environnement du conteneur execution-service ; à donner
                  seulement sans conteneur (étape 1) si le .env du service les change : le
                  délai d'attente de chaque réponse en dépend (read_timeout_s).
Le jeton n'est jamais affiché.
"""

import argparse
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

COMPILED_LANGUAGES = ("Java", "C", "C++", "C#", "Go", "Rust")
# Langages interprétés dont le noteur génère un mandataire par symbole soumis, et refuse celui
# qui masque une intégrée (CodeAssembler : assemblePython, assembleJsRpc, assembleBashRpc).
PROXIED_LANGUAGES = ("Python", "JavaScript", "TypeScript", "Bash")
# Début du refus écrit par CodeAssembler (SHADOW_PREFIX), suivi du nom.
RESERVED_NAME = "Nom réservé : « "

# Déclarations que le noteur lit dans un code (mêmes motifs que CodeAssembler : PY_DEF/PY_CLASS,
# JS_CALLABLE/JS_CLASS, BASH_FUNC). Un nom que le code de départ déclare n'est jamais refusé.
# Un nom que le noteur lit et que ce script raterait sortait À VÉRIFIER (« aucune fonction du code
# de départ »), et --unpublish fermait un quiz juste : chaque forme reconnue par CodeAssembler
# doit l'être ici. Identifiants UNICODE comme côté Java (`[\p{L}_]\w*` sous `(?U)`) : en `re`,
# `[^\W\d]` est une lettre ou `_` (`\w` y est Unicode), `def carré` compte donc pour `carré`.
_NAME = r"[^\W\d]\w*"
_JS_NAME = r"(?:[^\W\d]|\$)[\w$]*"
_JS_EXPORT = r"(?:export\s+(?:default\s+)?)?"
DECLARATIONS = {
    # PY_DEF : `def f`, `async def f` et `f = lambda …` (fonction de premier niveau aussi).
    "Python": (r"(?m)^(?:(?:async\s+)?def\s+(" + _NAME + r")|(" + _NAME + r")\s*=\s*lambda\b)",
               r"(?m)^class\s+(" + _NAME + r")"),
    "JavaScript": (r"(?m)^" + _JS_EXPORT + r"(?:async\s+)?function\s*(?:\*\s*)?(" + _JS_NAME + r")",
                   r"(?m)^" + _JS_EXPORT + r"(?:const|let|var)\s+(" + _JS_NAME + r")\s*=",
                   r"(?m)^" + _JS_EXPORT + r"(?:abstract\s+)?class\s+(" + _JS_NAME + r")"),
    # BASH_FUNC : `f()`, `function f()` et `function f {` (sans parenthèses).
    "Bash": (r"(?m)^(?:function\s+(" + _NAME + r")|(" + _NAME + r")\s*\(\s*\))",),
}
DECLARATIONS["TypeScript"] = DECLARATIONS["JavaScript"]


# Un harnais compilé qui TESTE UNE EXCEPTION du code soumis ne peut plus réussir : le noteur est
# un autre programme, et l'exception ne lui parvient pas avec son type (Java la relance en
# RuntimeException générique, Go en panic générique que recover() rattrape sans la valeur
# d'origine ; C, C++, C# et Rust s'arrêtent à l'appel refusé). Java et Go restent signalés : seul
# un humain voit si le harnais dépend du type ou de la valeur de l'exception. Le rejeu du
# code de départ, qui ne lève rien, rend « faux » comme pour tout harnais normal : sans ce
# contrôle statique, la question sortait OK et notait 0 à toute bonne réponse après la bascule.
EXCEPTION_HARNESS = {
    "Java": r"\bcatch\s*\(|\bassertThrows\b",
    "C#": r"\bcatch\b|\bAssert\.Throws\b",
    "C++": r"\bcatch\s*\(",
    "C": r"\bsetjmp\b|\bsignal\s*\(",
    "Rust": r"\bcatch_unwind\b|\bshould_panic\b",
    "Go": r"\brecover\s*\(",
}


def tests_an_exception(language, harness):
    """Le harnais compilé attrape-t-il une exception (ou un panic) ? FONCTION PURE (testée)."""
    pattern = EXCEPTION_HARNESS.get(language)
    return bool(pattern and re.search(pattern, without_comments(harness or "")))


def declared_names(language, start_code):
    """Noms que le code de départ déclare, lus comme le noteur. FONCTION PURE (testée)."""
    names = set()
    for pattern in DECLARATIONS.get(language, ()):
        for match in re.finditer(pattern, start_code or ""):
            # Motifs à plusieurs formes : le premier groupe capturé, comme matchAll côté Java.
            names.add(next(group for group in match.groups() if group))
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
TOOL_ABORTED = "Un outil de la notation n'a pas abouti"
# Signature d'un compilateur TUÉ sous son pilote (copie de TOOL_KILLED du superviseur) : gcc, g++
# et `go build` survivent à la mort de leur travailleur (cc1, compile) et sortent en 1, comme pour
# un vrai diagnostic. Un « Le harnais ne compile pas » qui la porte (superviseur antérieur à sa
# reconnaissance, ou copie divergente) n'est pas une preuve contre le harnais.
TOOL_KILLED = re.compile(
    r"^(?:gcc|g\+\+|cc|c\+\+): fatal error: Killed signal terminated program [\w+.-]+$"
    r"|^(?:[ \t]*= note: )?collect2: fatal error: [\w+.-]+ terminated with signal 9 \[Killed\]$"
    r"|^[\w./-]+: /\S+/pkg/tool/\w+/(?:compile|link|asm): signal: killed$", re.M)
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
# Le noteur n'a pas répondu (saturé, injoignable, réponse coupée) : rien n'est su de la question.
# Jamais de fermeture de quiz sur ce seul motif ; la sortie vaut EXIT_UNAVAILABLE, à relancer.
UNAVAILABLE = "NOTEUR INDISPONIBLE"
EXIT_UNAVAILABLE = 3

# Nouveaux essais quand le noteur est saturé (429, 502 « indisponible ») ou injoignable
# (connexion impossible, seul cas que core retente) : attente doublée de 1 s à 10 s comme core
# (ExecutionClient), pendant 2 min au total depuis le premier échec (EXEC_UNREACHABLE_RETRY_MS
# de core) ; un 429 donne son Retry-After.
RETRY_FIRST_DELAY_S = 1
RETRY_MAX_DELAY_S = 10
RETRY_BUDGET_S = 120
# Cause du 502 d'execution-service (GlobalExceptionHandler : CAUSE, UNAVAILABLE, NO_VERDICT).
CAUSE = "cause"
CAUSE_UNAVAILABLE = "indisponible"
CAUSE_NO_VERDICT = "sans_verdict"


class GraderUnavailable(Exception):
    """Aucune réponse exploitable du noteur, faute du noteur et non de la question.

    `unreachable` : la connexion même était impossible (service arrêté, mauvaise URL) ; les
    questions suivantes ne sont alors plus tentées (cf. check_question)."""

    def __init__(self, message, unreachable=False):
        super().__init__(message)
        self.unreachable = unreachable


class GraderNoVerdict(Exception):
    """502 « sans_verdict » : le conteneur a tourné avec ce code sans rendre de verdict."""

# Même borne que core (ExecutionClient) : un temps limite plus long n'est jamais demandé.
MAX_TIMEOUT_MS = 60_000

# Délai d'attente de la réponse : le PIRE CAS serveur, miroir de core-service
# ExecutionClient.readTimeoutMs (mêmes termes, mêmes défauts). Plus court, le script renonçait
# pendant une correction encore en cours : « le noteur n'a pas répondu », À VÉRIFIER, et
# --unpublish fermait un quiz juste. Les termes (`_X` ici = constante `X` d'ExecutionClient ;
# ExecutionClientDriftTest vérifie qu'ils restent égaux) :
_BASE_READ_MS = 10_000            # app.execution-service.read-timeout-ms de core
_PER_TEST_MS = 20_000             # app.execution-service.per-test-timeout-ms de core
_RUN_MARGIN_MS = 5_000
_EXEC_WALL_SLACK_MS = 75_000      # RunnerExec.WALL_OVERHEAD_MS
_EVAL_MAX_WALL_MS = 15 * 60_000   # DockerEvaluator.MAX_WALL_MS
# Cycle de vie d'UN conteneur hors de son mur, démon lent (chaque appel juste sous ses bornes) :
# 7 appels au démon × (connexion 5 s + silence 60 s) + lecture des journaux 30 s = 485 s, payé
# une fois par job compilé et une fois par unité interprétée (miroirs de DockerSandbox).
_DAEMON_RESPONSE_MS = 60_000      # DockerSandbox.RESPONSE_TIMEOUT
_DAEMON_CONNECT_MS = 5_000        # DockerSandbox.CONNECTION_TIMEOUT
_LOG_READ_MS = 30_000             # DockerSandbox.logReadTimeout
_DAEMON_CALLS_OUTSIDE_WALL = 7
_CONTAINER_LIFECYCLE_MS = (_DAEMON_CALLS_OUTSIDE_WALL * (_DAEMON_CONNECT_MS + _DAEMON_RESPONSE_MS)
                           + _LOG_READ_MS)
# Réglages d'execution-service partagés par le .env commun : lus dans l'environnement de son
# conteneur, sinon dans celui du script, sinon leur défaut d'application.properties
# (cf. server_settings).
_DEFAULT_QUEUE_WAIT_MS = 120_000          # EXEC_INTERNAL_QUEUE_WAIT_MS
_DEFAULT_INTERPRETED_BUDGET_MS = 900_000  # EXEC_INTERPRETED_BUDGET_MS
SERVER_SETTINGS = ("EXEC_INTERNAL_QUEUE_WAIT_MS", "EXEC_INTERPRETED_BUDGET_MS")
# Marge au-delà du pire cas modélisé : surestimer ne coûte que de l'attente.
_READ_SAFETY_MS = 60_000
# Plafond du délai, comme core (Integer.MAX_VALUE ms, environ 24,8 jours).
_MAX_READ_TIMEOUT_MS = 2**31 - 1


def _env_ms(environ, name, default):
    value = (environ.get(name) or "").strip()
    return int(value) if value.isdigit() else default


def container_setting(env_lines, name):
    """Valeur de `name` dans les lignes NOM=valeur de l'environnement d'un conteneur, ou None.
    FONCTION PURE (testée)."""
    for line in env_lines:
        key, _, value = line.partition("=")
        if key == name:
            return value.strip()
    return None


def server_settings(env_lines, environ):
    """Réglages d'execution-service dont dépend le délai d'attente. FONCTION PURE (testée).

    Ceux du CONTENEUR d'abord, comme le port et le jeton : sur l'hôte de prod (étape 2), le
    shell qui lance le script n'a pas chargé .env.docker, et un budget relevé là ne raccourcit
    plus l'attente du script sous la correction réelle. Le shell ensuite (étape 1 : service lancé
    par bootRun, sans conteneur), puis les défauts (read_timeout_s)."""
    settings = {}
    for name in SERVER_SETTINGS:
        for value in (container_setting(env_lines, name), environ.get(name)):
            if value and value.strip().isdigit():
                settings[name] = value.strip()
                break
    return settings


def read_timeout_s(environ):
    """Délai d'attente de la réponse du noteur, en secondes. FONCTION PURE (testée).

    Compilé : une attente de place interne, puis le mur du conteneur (15 min au plus) et son
    cycle de vie. Interprété : le budget global du serveur, plus l'unité déjà partie quand il
    expire (attente de place + temps limite + marge + mur exec + cycle de vie). Le script ne
    rejoue ni SQL ni vues (deux unités de dépassement côté core)."""
    queue = _env_ms(environ, "EXEC_INTERNAL_QUEUE_WAIT_MS", _DEFAULT_QUEUE_WAIT_MS)
    budget = _env_ms(environ, "EXEC_INTERPRETED_BUDGET_MS", _DEFAULT_INTERPRETED_BUDGET_MS)
    compiled = (_BASE_READ_MS + queue + _EVAL_MAX_WALL_MS + _RUN_MARGIN_MS
                + _CONTAINER_LIFECYCLE_MS)
    unit = (queue + max(_PER_TEST_MS, MAX_TIMEOUT_MS + _RUN_MARGIN_MS) + _EXEC_WALL_SLACK_MS
            + _CONTAINER_LIFECYCLE_MS)
    interpreted = _BASE_READ_MS + budget + unit
    # Borné comme core (MAX_READ_TIMEOUT_MS) : un budget démesuré (Long.MAX_VALUE) donnait un
    # délai que socket.settimeout refuse (OverflowError), et le script s'arrêtait dès la première
    # question.
    return min(max(compiled, interpreted) + _READ_SAFETY_MS, _MAX_READ_TIMEOUT_MS) / 1000

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
    if text.startswith((HARNESS_BUILD_ABORTED, TOOL_ABORTED)):
        # Compilation du noteur, inventaire javap, javac du serveur RPC (Java) ou sonde des
        # noms réservés expirés ou tués (machine chargée) : pas un diagnostic. Sur le chemin interne, ces cas arrivent déjà en
        # 502 « sans verdict » (exception ci-dessous) ; le préfixe n'est qu'un filet. Même
        # verdict que le repli final aujourd'hui : la branche est EN TÊTE pour qu'aucune règle
        # OK ou BLOQUANT ajoutée plus bas ne puisse s'appliquer à ces messages.
        return TO_CHECK
    if text.startswith(HARNESS_BUILD_ERROR):
        # BLOQUANT seulement sur un vrai diagnostic du compilateur, et pas quand le harnais
        # appelle une fonction que le code de départ ne contient pas (squelette à compléter) :
        # --unpublish ne ferme un quiz que si la preuve est là.
        diagnostic = text.split("\n", 1)[1].strip() if "\n" in text else ""
        if not diagnostic or missing_from_start_code(diagnostic, start_code):
            return TO_CHECK
        # Compilateur TUÉ (OOM) sous gcc/g++/go build, qui sortent en 1 : pas un diagnostic, et
        # --unpublish fermerait un quiz juste.
        if TOOL_KILLED.search(diagnostic):
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
    """Statut d'une question : le pire de ses cas. FONCTION PURE (testée).

    Une preuve (BLOQUANT, À VÉRIFIER) passe avant l'indisponibilité du noteur."""
    for status in (BLOCKING, TO_CHECK, UNAVAILABLE):
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
    value = container_setting(env_lines, "EXEC_SERVICE_PORT")
    return int(value) if value and value.isdigit() else DEFAULT_EXEC_PORT


def container_env(container):
    """Lignes NOM=valeur de l'environnement du conteneur execution-service ; vide s'il n'existe
    pas (étape 1 : service lancé par bootRun, EXEC_URL et INTERNAL_TOKEN donnés)."""
    try:
        return run(["docker", "inspect", "-f",
                    "{{range .Config.Env}}{{println .}}{{end}}", container]).splitlines()
    except (subprocess.CalledProcessError, OSError):
        return []


def exec_url(container, env_lines):
    if os.environ.get("EXEC_URL"):
        return os.environ["EXEC_URL"].rstrip("/")
    ip = run(["docker", "inspect", "-f",
              "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container]).split()
    if not ip:
        raise RuntimeError("IP du conteneur %s introuvable (donner EXEC_URL)" % container)
    return "http://%s:%d" % (ip[0], exec_port(env_lines))


def internal_token(container):
    token = os.environ.get("INTERNAL_TOKEN") or run(
        ["docker", "exec", container, "printenv", "INTERNAL_TOKEN"]).strip()
    if not token:
        raise RuntimeError("INTERNAL_TOKEN introuvable")
    return token


def case_name(case, index):
    """Nom envoyé pour le cas `index` (0-based) : « cas N » s'il est vide, comme core. FONCTION PURE
    (testée)."""
    name = case.get("name")
    return name if name and name.strip() else "cas %d" % (index + 1)


# Délai d'ÉTABLISSEMENT de la connexion, distinct du délai de lecture (read_timeout_s). urlopen
# n'en a qu'un : un hôte qui ignore les paquets (pare-feu, mauvaise IP) bloquait le script près
# d'une demi-heure dès la première question. 10 s : core en prend 3 (connect-timeout-ms) depuis
# le réseau du compose, le script peut passer par l'hôte ou Docker Desktop ; plus court, un
# service lent à accepter passerait pour injoignable et les questions suivantes seraient
# sautées. Chaque essai coûte au plus ce délai, dans le budget de RETRY_BUDGET_S.
CONNECT_TIMEOUT_S = 10


class SplitTimeoutConnection(http.client.HTTPConnection):
    """Connexion HTTP qui s'établit en CONNECT_TIMEOUT_S au plus, puis lit avec le délai de la
    requête. Une connexion qui expire lève TimeoutError pendant l'envoi : urllib l'enveloppe
    dans une URLError, traitée comme un refus (nouveaux essais, puis service injoignable)."""

    def connect(self):
        read_timeout = self.timeout
        self.timeout = CONNECT_TIMEOUT_S
        try:
            super().connect()
        finally:
            self.timeout = read_timeout
        self.sock.settimeout(read_timeout)


class SplitTimeoutHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(SplitTimeoutConnection, req)


# build_opener remplace le HTTPHandler par défaut par sa sous-classe (EXEC_URL est en http).
OPENER = urllib.request.build_opener(SplitTimeoutHandler)


def evaluate(base_url, token, question, timeout_s=None):
    body = {
        "language": question["language"],
        "code": question["start_code"],
        # Comme core à la correction : un nom que le code de départ déclare est celui que
        # l'énoncé impose, et n'est pas refusé comme « Nom réservé » (#22).
        "startCode": question["start_code"],
        # Nom vide → « cas N », comme core (ExecutionClient) : execution-service exige un nom
        # (@NotBlank), et un 400 classait À VÉRIFIER — voire fermait (--unpublish) — une question
        # que la correction réelle note normalement.
        "testCases": [{"name": case_name(c, i), "harnessCode": c["harnessCode"],
                       "weight": c["weight"]} for i, c in enumerate(question["cases"])],
    }
    timeout_ms = question.get("exec_timeout_ms")
    if timeout_ms and timeout_ms > 0:
        body["timeoutMs"] = min(timeout_ms, MAX_TIMEOUT_MS)
    request = urllib.request.Request(
        base_url + "/internal/exec/evaluate", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Internal-Token": token}, method="POST")
    # Une correction peut tenir près d'une demi-heure (attente d'une place, compilations ou
    # budget interprété, démon Docker lent) : cf. read_timeout_s ; main le calcule avec les
    # réglages du conteneur.
    if timeout_s is None:
        timeout_s = read_timeout_s(os.environ)
    with OPENER.open(request, timeout=timeout_s) as response:
        return json.loads(response.read().decode("utf-8"))


def error_cause(error):
    """Cause d'un 502 d'execution-service (« indisponible », « sans_verdict »), ou None si le
    corps est illisible. FONCTION PURE sur l'erreur reçue (testée)."""
    try:
        return json.loads(error.read().decode("utf-8")).get(CAUSE)
    except (OSError, ValueError, AttributeError, TypeError):
        return None


def retry_after_s(error):
    """Délai demandé par l'en-tête Retry-After (secondes entières), ou None. FONCTION PURE."""
    value = ((error.headers or {}).get("Retry-After") or "").strip()
    return int(value) if value.isdigit() else None


def evaluate_with_retry(base_url, token, question, timeout_s=None):
    """evaluate, retenté tant que le noteur est saturé ou injoignable (RETRY_BUDGET_S au plus,
    comptés depuis le PREMIER échec retenté).

    Retenté : 429 (en suivant Retry-After) et 502 « indisponible » — deux réponses où rien n'a
    tourné —, et l'URLError d'une requête qui n'est pas partie (connexion refusée, hôte
    introuvable), seul cas que core retente aussi. Lève GraderUnavailable quand le budget est
    épuisé, ou sans nouvel essai pour une réponse coupée ou un délai de lecture dépassé (la
    correction a pu tourner : la relancer prendrait une place de plus) et pour un jeton refusé ;
    GraderNoVerdict sur un 502 « sans_verdict ». Tout autre échec remonte tel quel.

    Le budget ne part pas avant le premier appel : un appel interne attend déjà jusqu'à
    EXEC_INTERNAL_QUEUE_WAIT_MS (120 s) une place côté serveur avant de répondre 429, et une
    échéance posée avant lui était épuisée dès ce premier refus — aucun nouvel essai."""
    deadline = None
    delay = RETRY_FIRST_DELAY_S
    unreachable = False
    while True:
        try:
            return evaluate(base_url, token, question, timeout_s=timeout_s)
        except urllib.error.HTTPError as e:
            # Corps lu puis réponse fermée : une erreur gardée ouverte par essai épuisait les
            # connexions pendant les 2 min de nouveaux essais.
            cause = error_cause(e) if e.code == 502 else None
            e.close()
            unreachable = False   # le service a répondu : il tourne
            if e.code in (401, 403):
                raise GraderUnavailable("jeton interne refusé (HTTP %d) : vérifier "
                                        "INTERNAL_TOKEN" % e.code) from e
            if e.code == 502:
                if cause == CAUSE_NO_VERDICT:
                    raise GraderNoVerdict() from e
                if cause != CAUSE_UNAVAILABLE:
                    raise
                reason, wait = "sandbox indisponible (HTTP 502)", delay
            elif e.code == 429:
                reason = "noteur saturé (HTTP 429)"
                wait = retry_after_s(e)
                wait = delay if wait is None else wait
            else:
                raise
        except urllib.error.URLError as e:
            # Levée AVANT l'envoi complet de la requête (urllib n'enveloppe que la connexion et
            # l'envoi) : aucune correction n'a pu commencer.
            reason, wait = "noteur injoignable (%s)" % e.reason, delay
            unreachable = True
        except (OSError, http.client.HTTPException) as e:
            # Pendant la LECTURE de la réponse : délai dépassé, connexion coupée, réponse tronquée.
            raise GraderUnavailable("le noteur n'a pas répondu : %s"
                                    % (str(e) or type(e).__name__)) from e
        if deadline is None:
            deadline = time.monotonic() + RETRY_BUDGET_S
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GraderUnavailable("%s, toujours après %d s de nouveaux essais"
                                    % (reason, RETRY_BUDGET_S), unreachable=unreachable)
        time.sleep(min(wait, remaining))
        delay = min(delay * 2, RETRY_MAX_DELAY_S)


def static_checks(question):
    """(statuts, lignes) des contrôles qui ne demandent pas le noteur. FONCTION PURE (testée)."""
    lines, statuses = [], []
    for case in question["cases"]:
        if tests_an_exception(question["language"], case["harnessCode"]):
            statuses.append(TO_CHECK)
            lines.append("cas %s « %s » : le harnais teste une exception du code soumis ; le "
                         "noteur séparé n'en reçoit pas le type, toute bonne réponse échouera. "
                         "Réécrire le harnais (valeur de retour sentinelle) et le rejouer avec "
                         "une solution" % (case["id"], case["name"]))
    if question["language"] in PROXIED_LANGUAGES:
        for case in question["cases"]:
            if not harness_uses_start_code(question["language"], question["start_code"],
                                           case["harnessCode"]):
                statuses.append(TO_CHECK)
                lines.append("cas %s « %s » : le harnais n'emploie aucune fonction du code de "
                             "départ ; si l'énoncé impose un nom d'intégrée (max, sum…), le "
                             "déclarer dans le code de départ" % (case["id"], case["name"]))
    return statuses, lines


def check_question(base_url, token, question, timeout_s=None, grader=None):
    """(statut, lignes de détail) d'une question.

    Les contrôles statiques passent AVANT l'appel au noteur : un harnais déjà prouvé en cause
    garde son statut (et son quiz est fermé par --unpublish) même si le noteur ne répond pas.
    `grader` : état partagé entre les questions d'une exécution ({"unreachable": bool}) ; une
    fois la connexion impossible après tous les nouveaux essais, les questions suivantes ne sont
    plus tentées — un service arrêté coûtait sinon 2 min par question avant la sortie 3."""
    if not (question.get("start_code") or "").strip():
        return TO_CHECK, ["pas de code de départ : rejouer à la main avec une solution"]
    statuses, lines = static_checks(question)
    if grader is not None and grader.get("unreachable"):
        grader["incomplete"] = grader.get("incomplete", 0) + 1
        statuses.append(UNAVAILABLE)
        lines.append("non rejouée : noteur injoignable à une question précédente ; relancer "
                     "le script")
        return worst(statuses), lines
    try:
        results = evaluate_with_retry(base_url, token, question, timeout_s=timeout_s)
    except GraderUnavailable as e:
        # Rien n'est su du verdict du noteur : ni preuve ni fermeture sur ce seul motif.
        if grader is not None:
            grader["incomplete"] = grader.get("incomplete", 0) + 1
            grader["unreachable"] = grader.get("unreachable") or e.unreachable
        statuses.append(UNAVAILABLE)
        lines.append("%s : relancer le script" % e)
        return worst(statuses), lines
    except GraderNoVerdict:
        # Le conteneur a tourné avec le code de départ sans rendre de verdict : rien ne prouve
        # que le harnais tourne (même classement qu'avant les nouveaux essais).
        statuses.append(TO_CHECK)
        lines.append("le noteur n'a rendu aucun verdict (HTTP 502 sans_verdict) : rejouer à la "
                     "main avec une solution")
        return worst(statuses), lines
    except (OSError, http.client.HTTPException, ValueError) as e:
        # Réponse du noteur qui refuse la demande (400, 500…) ou illisible : sans ce filet le
        # script s'arrêtait là, sans rejouer les questions suivantes ni fermer les quiz bloquants.
        statuses.append(TO_CHECK)
        lines.append("le noteur a refusé ou rendu une réponse illisible : %s" % e)
        return worst(statuses), lines
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


def parse_ack(text):
    """Ids de questions acquittées (« 12,15 ») → ensemble d'entiers. FONCTION PURE (testée)."""
    return {int(part) for part in (text or "").replace(" ", "").split(",") if part}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--unpublish", action="store_true",
                        help="fermer les quiz publiés qui portent une question BLOQUANT ou "
                             "À VÉRIFIER non acquittée")
    parser.add_argument("--allow-empty", action="store_true",
                        help="accepter un inventaire VIDE (base sans question compilée ni "
                             "interprétée) : sans cette option, c'est une erreur (sortie 2), un "
                             "dump non chargé donnant sinon un faux feu vert")
    parser.add_argument("--ack", default="",
                        help="ids de questions À VÉRIFIER déjà rejouées à la main avec une "
                             "solution, séparés par des virgules : elles ne bloquent plus la "
                             "sortie en 0 (un BLOQUANT ne s'acquitte pas)")
    args = parser.parse_args()
    acknowledged = parse_ack(args.ack)
    pg = os.environ.get("PG_CONTAINER", "moodit_postgres")
    ex = os.environ.get("EXEC_CONTAINER", "moodit_execution")
    try:
        questions = json.loads(psql(pg, INVENTORY_SQL).strip() or "[]")
        env_lines = container_env(ex)
        base_url = exec_url(ex, env_lines)
        token = internal_token(ex)
    except (subprocess.CalledProcessError, RuntimeError, ValueError) as e:
        print("Inventaire impossible : %s" % e, file=sys.stderr)
        return 2

    if not questions and not args.allow_empty:
        # Une base où le dump ne s'est pas chargé (fichier mal recopié, chargement interrompu)
        # n'a aucune question : sortir en 0 donnait le feu vert sans rien avoir rejoué.
        print("Inventaire vide : aucune question à rejouer. Le dump est-il chargé ? "
              "(--allow-empty si la base n'en a vraiment aucune)", file=sys.stderr)
        return 2
    timeout_s = read_timeout_s(server_settings(env_lines, os.environ))
    print("%d question(s) à rejouer (attente maximale de %d s par question)."
          % (len(questions), timeout_s))
    counts = {BLOCKING: 0, TO_CHECK: 0, OK: 0, UNAVAILABLE: 0}
    # Quiz publiés qui portent une question non réglée : eux seuls bloquent la sortie, et
    # --unpublish les ferme. Un À VÉRIFIER non acquitté en fait partie : un harnais qui teste
    # une exception, ou une fonction aux types non transportables, note 0 à toute bonne réponse.
    blocked_published = set()
    drafts = 0
    # « incomplete » : questions dont le noteur n'a pas pu donner son verdict, même quand un
    # contrôle statique les classe déjà (le noteur aurait pu les trouver BLOQUANT).
    grader = {"unreachable": False, "incomplete": 0}
    for question in questions:
        status, lines = check_question(base_url, token, question, timeout_s, grader)
        if status == TO_CHECK and int(question["question_id"]) in acknowledged:
            status = OK
            lines = ["acquittée (--ack) : rejouée à la main"] + lines
        counts[status] += 1
        print("[%s] quiz %s « %s »%s, question %s (%s)" % (
            status, question["quiz_id"], question["quiz_title"],
            " (publié)" if question["published"] else "", question["question_id"],
            question["language"]))
        for line in lines:
            print("    " + line)
        if status in (BLOCKING, TO_CHECK):
            if question["published"]:
                blocked_published.add(int(question["quiz_id"]))
            else:
                drafts += 1

    print("\nBilan : %d bloquant(s), %d à vérifier, %d ok, %d sans réponse du noteur." % (
        counts[BLOCKING], counts[TO_CHECK], counts[OK], counts[UNAVAILABLE]))
    if drafts:
        print("Dont %d dans des quiz non publiés : sans effet sur la sortie, à corriger avant "
              "d'ouvrir leur quiz." % drafts)
    if blocked_published:
        ids = ", ".join(str(i) for i in sorted(blocked_published))
        if args.unpublish:
            psql(pg, "UPDATE Quiz SET is_published = false WHERE id IN (%s);" % ids)
            print("Quiz fermés (is_published = false) : %s" % ids)
        else:
            print("Quiz publiés à corriger ou fermer : %s (--unpublish pour les fermer)" % ids)
    if grader["incomplete"]:
        # Contrôle INCOMPLET : ces questions n'ont pas eu le verdict du noteur, leur quiz n'est
        # fermé que sur une preuve statique. La sortie le dit avant tout le reste : le résultat
        # n'est pas définitif.
        print("%d question(s) sans verdict du noteur (indisponible) : vérifier execution-service "
              "puis relancer le script (sortie %d)." % (grader["incomplete"], EXIT_UNAVAILABLE),
              file=sys.stderr)
        return EXIT_UNAVAILABLE
    return 1 if blocked_published else 0


if __name__ == "__main__":
    sys.exit(main())
