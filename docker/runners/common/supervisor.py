#!/usr/bin/env python3
"""Superviseur de notation MoodIT (#116) — processus de CONFIANCE du conteneur runner.

Tourne en root dans un conteneur jetable (réseau coupé, /box et /tmp en tmpfs bornés — seuls
points d'écriture de l'UID étudiant, les images verrouillant leurs répertoires monde-inscriptibles).
Le code étudiant, lui, ne tourne JAMAIS en root : chaque cas est exécuté sous l'UID `student`,
sans toolchain (binaires de test autonomes), sources verrouillées en 700 root.

Modèle de confiance :
  - INTÉGRITÉ  : verdict fail-closed multi-canaux (exit code + marqueurs du framework + rapport
    cohérent). Deux CANARIS par soumission (un qui doit réussir, un qui doit échouer, valeurs
    tirées au sort à l'exécution, position mélangée) : un rapport forgé qui ne les reproduit pas
    exactement est détecté → toute la soumission échoue et l'événement est remonté.
  - CONFIDENTIALITÉ : les sources (harnais compris) appartiennent à root en 700 dès leur
    extraction ; le processus étudiant reçoit EACCES s'il tente de les lire. Limite assumée :
    les constantes compilées dans les artefacts restent extractibles par un étudiant déterminé.
  - DÉTECTION  : le run est tracé par strace (openat/open/readlink) quand la capacité SYS_PTRACE
    est disponible ; toute ouverture d'une source verrouillée devient un événement
    `lecture_source_tentee`. Dégradation propre sans strace (`trace_indisponible`).

Deux MODES (job.json) :
  - « evaluate » (défaut) : notation des langages COMPILÉS décrite ci-dessus
    (/box/cases/<i>/src/… ; résultats alignés sur l'ordre des cas + événements).
  - « exec » : exécution GÉNÉRIQUE d'un programme assemblé (/box/src/…) — reprend le rôle de
    Piston pour les interprétés/SQL/vues (programmes RPC 2-processus à nonce, inchangés) et pour
    le bouton « Exécuter » de tous les langages. Tout y tourne sous l'UID étudiant (le noteur
    assemblé embarque sa propre protection : nonce, auto-suppression), avec une étape de
    compilation (root) pour les langages qui en ont une. Sortie : {compile?, run} à la Piston.

Entrée  : job.json + les sources, copiés par execution-service AVANT le démarrage dans
          /opt/moodit/staging (sentinelle .ready en dernier), puis déplacés ici dans le
          tmpfs /box par wait_for_files().
Sortie  : UN objet JSON sur stdout.
Le protocole côté Java vit dans execution-service/…/sandbox/ ; garder les deux en phase.
"""

import collections
import glob
import json
import os
import random
import re
import resource
import shutil
import signal
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET

BOX = "/box"
STUDENT_NAME = "student"
# UID/GID de l'étudiant : valeurs des images, RANDOMISÉES au démarrage par
# randomize_student_uid() — voir sa docstring (RLIMIT_NPROC est un budget PARTAGÉ entre
# conteneurs quand l'UID est le même).
STUDENT_UID = 1300
STUDENT_GID = 1300
READY_WAIT_S = 30
COMPILE_TIMEOUT_S = 90
LIST_TIMEOUT_S = 5              # inventaire `--list` : s'ajoute au pire cas, donc borné court
DEFAULT_RUN_TIMEOUT_S = 10
MAX_RUN_TIMEOUT_S = 60
OUTPUT_CAP = 64 * 1024          # tronque ce qu'on relit des sorties capturées
FSIZE_LIMIT = 32 * 1024 * 1024  # borne les fichiers écrits par le processus étudiant
# Plafond des fichiers de sortie, miroir de FSIZE_LIMIT : ils sont désormais écrits par
# ROOT (qui n'est pas soumis à la rlimit de l'étudiant), donc la borne doit être ici.
OUTPUT_FILE_CAP = FSIZE_LIMIT
PUMP_JOIN_S = 10                # attente bornée des pompes de sortie après la mort
PUMP_SWEEP_JOIN_S = 1           # attente APRÈS le balayage de secours (tube libéré)
# Queue conservée quand la sortie dépasse le plafond : CALÉE sur la fenêtre de queue de
# read_capped, pour que tout ce que la pompe garde soit effectivement relu.
PUMP_TAIL_BYTES = OUTPUT_CAP // 2

class EtatSortie:
    """Capture des sorties d'UN cas : des octets ont-ils été perdus (tmpfs saturé) ?

    La queue est alors perdue, donc la ligne du jeton aussi. Sans cet état, Java et C#
    tiraient leur « looked_ok » du XML sous work/ (déjà écrit) et concluaient « jeton
    absent », c'est-à-dire une accusation de forgeage pour une saturation.

    C'est un OBJET remplacé à chaque cas, et non un drapeau global : les pompes de sortie
    peuvent SURVIVRE à leur run_proc, et un global aurait été repositionné par une pompe
    retardataire pendant le cas SUIVANT — désarmant la détection de forgeage sur un cas où
    rien n'avait saturé. Une pompe retardataire n'écrit que dans l'état de SON cas."""

    def __init__(self, case_index=None):
        self.perdue = False
        self.case = case_index
        # Un processus du cas est mort PAR SIGNAL (OOM du cgroup, SIGSEGV…). Posé ici plutôt
        # que dans chacun des six runners : run_proc est le seul endroit qui voie le code brut.
        self.tue_par_signal = False
        # Un processus du cas a dépassé son temps limite. Les runners écrasent l'information
        # (« if timed_out or code != 0: Échec de compilation »), si bien qu'une COMPILATION
        # expirée arrivait avec timed_out=False et passait pour une cause concluante : un code
        # lent à compiler se faisait accuser de sabotage.
        self.expire = False


ETAT_SORTIE = EtatSortie()

EVENTS = []


def event(etype, case=None, detail=None):
    e = {"type": etype}
    if case is not None:
        e["case"] = case
    if detail:
        e["detail"] = detail[:500]
    EVENTS.append(e)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def read_capped(path, cap=OUTPUT_CAP):
    """Relit une sortie capturée en bornant la mémoire : TÊTE + QUEUE du fichier quand il
    dépasse le plafond. La queue est indispensable aux canaux de VERDICT — jeton de fin,
    sommaire du framework, verdict encadré par nonce du mode exec — tous imprimés en fin de
    sortie : tronquer seulement la tête transformait une copie honnête mais bavarde
    (> 64 Kio de print de débogage) en « jeton absent », fausse accusation de triche."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size <= cap:
                return f.read().decode("utf-8", errors="replace")
            head = f.read(cap // 2)
            f.seek(size - cap // 2)
            tail = f.read()
        return (head.decode("utf-8", errors="replace")
                + "\n… (sortie tronquée au milieu : " + str(size) + " octets)\n"
                + tail.decode("utf-8", errors="replace"))
    except OSError:
        return ""


def with_uid(content, name, uid, gid):
    """Réécrit la ligne de {@code name} d'un /etc/passwd ou /etc/group avec de nouveaux
    UID/GID. FONCTION PURE (couverte par test_supervisor.py). Renvoie None si l'utilisateur
    est absent (rien à réécrire)."""
    lines = content.splitlines(keepends=True)
    found = False
    for i, line in enumerate(lines):
        fields = line.rstrip("\n").split(":")
        if len(fields) < 3 or fields[0] != name:
            continue
        fields[2] = str(uid)
        if len(fields) > 3 and fields[3].isdigit():   # /etc/passwd : le 4e champ est le GID
            fields[3] = str(gid)
        lines[i] = ":".join(fields) + ("\n" if line.endswith("\n") else "")
        found = True
    return "".join(lines) if found else None


def randomize_student_uid():
    """Donne à l'utilisateur étudiant un UID/GID TIRÉ AU SORT, propre à ce conteneur.

    RLIMIT_NPROC n'est pas une limite par conteneur : le noyau compte les processus par UID
    RÉEL et par espace de noms utilisateur — que les conteneurs runner partagent avec l'hôte.
    Avec l'UID fixe des images (1300), les 128 processus autorisés formaient un budget COMMUN
    à toutes les notations simultanées : un étudiant qui fork en boucle jusqu'à sa rlimit
    faisait échouer la correction d'un AUTRE (EAGAIN à sa première création de thread) — et,
    ses canaris tombant avec le reste, le faisait accuser de falsification. Un UID distinct
    par conteneur rend la rlimit réellement individuelle.

    Le nom (`student`) ne change pas : `strace -u student` et les Dockerfiles restent valides.
    Si /etc/passwd n'est pas réinscriptible, on garde l'UID de l'image (durcissement au mieux)
    et on le signale dans les logs."""
    global STUDENT_UID, STUDENT_GID
    uid = random.SystemRandom().randrange(20000, 60000)
    # TOUT OU RIEN : les deux contenus sont calculés AVANT la moindre écriture. Écrire
    # /etc/passwd puis échouer sur /etc/group laisserait le système et STUDENT_UID
    # désaccordés — l'étudiant ne pourrait plus écrire dans son work/, TOUS les cas
    # échoueraient (canaris compris) et la soumission serait étiquetée « falsification
    # probable » pour une simple erreur de configuration d'image.
    originals = {}
    updates = {}
    try:
        for path in ("/etc/passwd", "/etc/group"):
            with open(path, "r", encoding="utf-8") as f:
                originals[path] = f.read()
            updated = with_uid(originals[path], STUDENT_NAME, uid, uid)
            if updated is None:
                log("superviseur: utilisateur %s absent de %s — UID de l'image conservé"
                    % (STUDENT_NAME, path))
                return
            updates[path] = updated
        written = []
        try:
            for path, content in updates.items():
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
                written.append(path)
        except OSError:
            # Échec À MI-CHEMIN : on REVIENT en arrière. Laisser /etc/passwd sur le nouvel UID
            # alors que STUDENT_UID vaut encore celui de l'image désaccorderait le système —
            # l'étudiant ne pourrait plus écrire dans son work/, tous les cas échoueraient
            # (canaris compris) et la soumission serait étiquetée « falsification probable ».
            for path in written:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(originals[path])
            raise
    except OSError as e:
        log("superviseur: UID étudiant non randomisé (%r) — rlimit partagée entre conteneurs" % e)
        return
    STUDENT_UID = uid
    STUDENT_GID = uid


def demote_student():
    """preexec_fn du processus étudiant : UID dédié, groupe de processus, limites dures."""
    os.setsid()
    os.setgroups([])
    os.setgid(STUDENT_GID)
    os.setuid(STUDENT_UID)
    resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_LIMIT, FSIZE_LIMIT))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))


# Alphabets d'un identifiant tiré au sort : première lettre, puis lettres/chiffres/_ — et
# LONGUEUR variable. Un nom de forme fixe (« 1 majuscule + 9 minuscules ») restait
# reconnaissable à l'exécution sur les langages où le code étudiant peut interposer les
# fonctions de sortie : il suffisait de relayer honnêtement les tests dont le nom a cette
# forme (les canaris) et de ne forger que les autres.
# PREMIÈRE lettre en MAJUSCULE, impérativement : le canari Go s'appelle « Test<N> », et Go
# exige que le caractère suivant « Test » ne soit pas une minuscule (cmd/go isTest) — sinon la
# fonction n'est pas enregistrée comme test et `go vet` la refuse. Une initiale minuscule
# faisait échouer le canari d'une soumission Go HONNÊTE, donc l'accusait de falsification.
IDENT_FIRST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
IDENT_REST = IDENT_FIRST + "abcdefghijklmnopqrstuvwxyz0123456789_"


def random_identifier(rng, min_len=5, max_len=16):
    """Identifiant valide dans les six langages, de longueur variable. Majuscule en tête
    (contrainte Go « TestXxx ») ; la suite mélange casses, chiffres et _."""
    length = rng.randrange(min_len, max_len + 1)
    return rng.choice(IDENT_FIRST) + "".join(rng.choice(IDENT_REST) for _ in range(length - 1))


def junit_selection(case_index):
    """Canari : SA classe seulement. Cas réel : tout le classpath, MOINS les classes
    déclarées par l'étudiant (leurs tests ne doivent pas compter dans le verdict)."""
    name = CANARY_NAMES.get(case_index)
    if name:
        return ["--select-class=" + name]
    selection = ["--scan-class-path"]
    for student_type in STUDENT_TYPES.get(case_index) or []:
        selection.append("--exclude-classname=^" + re.escape(student_type) + "$")
    return selection


def nunit_selection(case_index):
    """Canari : SA classe seulement. Cas réel : filtre d'EXCLUSION des classes de l'étudiant
    (`--where "class != A and class != B"`)."""
    name = CANARY_NAMES.get(case_index)
    if name:
        return ["--test=" + name]
    types = STUDENT_TYPES.get(case_index) or []
    if not types:
        return []
    # Noms QUOTÉS : sans cela, un type étudiant nommé « and »/« or » produisait une
    # expression invalide — NUnitLite sortait en erreur, sans XML, sur une soumission honnête.
    return ["--where", " and ".join("class != '%s'" % t for t in types)]


JETON_MODULE = "zzzz_moodit_jeton"


def enclosing_type(container):
    """Type ENGLOBANT d'un conteneur de tests rapporté par le framework. JUnit écrit un type
    imbriqué « Harnais$Cas », NUnit « Harnais+Cas », alors que le harnais ne déclare que
    « Harnais » au niveau racine. FONCTION PURE (testée)."""
    return container.split("$")[0].split("+")[0]


def harness_ran(executed_containers, harness_types):
    """L'invariant de sûreté : au moins un test exécuté appartient-il au harnais ?
    FONCTION PURE (testée). Harnais non identifié → rien à vérifier, donc True (aucune
    exclusion n'a été appliquée dans ce cas, le harnais a forcément tourné).

    La comparaison tolère l'IMBRICATION (`@Nested`, `[TestFixture]` interne) : seul
    l'invariant est permissif, le filtrage d'exclusion reste par nom exact, donc l'intégrité
    de la note n'est pas affaiblie."""
    if not harness_types:
        return True
    expected = set(harness_types) | {enclosing_type(t) for t in harness_types}
    return any(c in expected or enclosing_type(c) in expected for c in executed_containers)


def libtest_ran_tests(stdout):
    """Modules des tests réellement exécutés, d'après les lignes « test mod::nom ... ok »
    de libtest (--nocapture). FONCTION PURE (testée)."""
    modules = []
    for line in stdout.splitlines():
        match = re.match(r"^test ([\w:]+) \.\.\.", line.strip())
        if match:
            modules.append(match.group(1).split("::")[0])
    return modules


RUST_TEST_PATH = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$")


def libtest_listed_tests(listing):
    """Noms des tests d'un binaire libtest, depuis sa sortie `--list` (« mod::test: test »).
    FONCTION PURE (testée).

    Ces noms repartent dans l'ARGV du binaire. Or le run `--list` exécute déjà du code
    étudiant (un constructeur de section d'initialisation tourne avant libtest), donc la
    sortie n'est PAS digne de confiance : une ligne forgée commençant par « - » deviendrait
    une OPTION de libtest et détournerait le filtre. On n'accepte donc que des chemins de test
    Rust bien formés — un identifiant, éventuellement qualifié par « :: ».

    TOUT OU RIEN : une seule ligne non conforme fait renvoyer None, et l'appelant renonce au
    filtre. Ignorer la ligne en silence serait pire que ne rien filtrer : la sélection est une
    LISTE BLANCHE, donc un nom écarté ici n'est pas exécuté du tout. Un harnais au nom de test
    accentué (`fn teste_données`, naturel dans un projet francophone) ou en identifiant brut
    (`r#match`) aurait ainsi vu ce test sauté, sans que l'invariant `harness_ran` s'en
    aperçoive — il lui suffit d'UN test du harnais. Renoncer au filtre ne coûte que l'équité."""
    names = []
    for line in listing.splitlines():
        line = line.strip()
        if line.endswith(": test"):
            name = line[: -len(": test")].strip()
            if not RUST_TEST_PATH.match(name):
                log("superviseur: nom de test libtest inattendu — filtre abandonné")
                return None
            names.append(name)
    return names


def usable_listing(listing, timed_out):
    """Listing `--list` exploitable, ou "" s'il ne l'est pas. FONCTION PURE (testée).

    Un listing TRONQUÉ (sortie plafonnée) perd les tests du MILIEU : bâtir un filtre dessus
    pouvait écarter le harnais sans que personne s'en aperçoive. On renonce alors au filtre —
    tous les tests tournent, l'équité est perdue mais pas l'intégrité. Isolée ici parce que
    c'est la SEULE protection contre ce cas, et qu'elle était jusqu'ici noyée dans run_rust,
    donc couverte par aucun test."""
    if timed_out or "sortie tronquée au milieu" in listing:
        return ""
    return listing


def libtest_selection(case_index, listing=""):
    """Canari : son test et celui du jeton. Cas réel : sélection EXACTE de tous les tests qui
    n'appartiennent pas à un module de l'étudiant.

    On sélectionne par nom COMPLET plutôt que d'exclure par `--skip`, parce que `--skip`
    filtre par SOUS-CHAÎNE : un module étudiant nommé `s` écartait « harnais::… » et il ne
    restait que le jeton — cas noté réussi sur un code arbitrairement faux. Ici la
    comparaison porte sur le PREMIER SEGMENT, donc `mod tests` (étudiant) et
    `mod moodit_tests` (prof) ne se confondent plus."""
    name = CANARY_NAMES.get(case_index)
    if name:
        return ["--exact", "m%s::t%s" % (name, name), JETON_MODULE + "::zzzz_jeton"]
    excluded = {t for t in (STUDENT_TYPES.get(case_index) or []) if t != JETON_MODULE}
    if not excluded:
        return []
    names = libtest_listed_tests(listing) or []
    keep = [n for n in names if n.split("::")[0] not in excluded]
    # Rien à retirer, ou rien à garder (listing illisible, tronqué ou refusé) : pas de filtre —
    # au pire les tests de l'étudiant comptent dans son verdict, et l'invariant « un test du
    # harnais a tourné » reste le garde-fou de l'intégrité de la note.
    if not names or not keep or len(keep) == len(names):
        return []
    return ["--exact"] + keep


def canary_reserve_seconds(budget_s, timeout_s):
    """Part du budget global gardée pour les deux canaris — FONCTION PURE (testée).

    Le pire cas théorique (2 × compilation + run) peut DÉPASSER le budget lui-même : sur un
    appel public, le mur est plafonné à 4 min. Le réserver tel quel ne laissait plus de place
    au moindre cas réel — le « Tester » du prof ne notait plus rien. La réserve est donc
    bornée au TIERS du budget : les canaris passent en priorité sur les cas réels, et les deux
    tiers restants suffisent toujours à en démarrer. LIMITE ASSUMÉE : cette part peut rester
    inférieure au pire cas des deux canaris (2 × (timeout + compilation)) — un premier canari
    très lent peut donc déborder et faire sauter le second. Le verdict devient alors
    « indetermines » (jamais une accusation), au prix d'un contrôle anti-falsification
    affaibli ce coup-là : c'est un épuisement de budget, pas une porte ouverte — il faudrait
    d'abord savoir forger le jeton (résiduel déjà assumé, cf. docker/runners/README.md)."""
    if budget_s <= 0:
        return 0.0
    return min(2.0 * (timeout_s + COMPILE_TIMEOUT_S), budget_s / 3.0)


def canary_verdict(cases, outcomes):
    """Verdict des canaris, FONCTION PURE (couverte par test_supervisor.py) : « aucun »,
    « ok », « incoherents » (falsification probable) ou « indetermines » (rien de concluant,
    sans accusation).

    Les canaris sont deux cas que le superviseur ajoute et dont il CONNAÎT le résultat attendu
    (l'un doit réussir, l'autre échouer), aux valeurs tirées au sort et à la position mélangée.
    Leur rôle : attraper un forgeage AVEUGLE, qui ne sait pas distinguer un cas réel d'un
    canari et finit donc par rendre vert celui qui devait échouer.

    Le jugement ne porte PAS sur la branche d'exécution (tous ont tourné / certains non) mais,
    canari par canari, sur la QUALITÉ DE LA PREUVE qu'il apporte. Trois états :
      - CONFIRMÉ : il a tourné et son résultat est bien celui attendu ;
      - NON CONFIRMÉ, cause CONCLUANTE : il a tourné et contredit son attendu, ou sa
        compilation a échoué sans cause non concluante (casser la compilation des seuls
        canaris, p. ex. par collision de nom de classe, est une falsification) ;
      - NON CONFIRMÉ, cause NON CONCLUANTE : temps limite dépassé ou mort par signal (OOM du
        cgroup, SIGSEGV). On ne peut rien en déduire sur l'intention — cf. inconclusive().

    D'où les règles, dans cet ordre :
      1. un canari non confirmé n'accuse QUE SI L'ÉTUDIANT Y GAGNE, c'est-à-dire si un cas
         réel ressort VERT. C'est le critère unique : un forgeage ne rapporte rien si aucun
         cas réel n'est vert, donc aucune détection n'est perdue, et toutes les façons dont un
         code HONNÊTE peut faire échouer ses canaris cessent d'accuser — expiration, mort par
         signal, mais aussi sortie non nulle sans signal (une panique Go au chargement sort
         avec le statut 2 ; en Go et C/C++ le code étudiant partage l'unité de compilation du
         canari, donc son init()/constructeur global y tourne aussi) ;
      2. un canari dont la COMPILATION a échoué pour une cause NON CONCLUANTE n'accuse jamais,
         même avec un cas réel vert : il n'a pas été saboté, il n'a pas pu être compilé ;
      3. sinon tout est confirmé → « ok », ou « indetermines » si un canari n'a rien vérifié
         (non imputable, ou non compilé pour une cause non concluante) : on n'accuse pas, mais
         on ne prétend pas non plus avoir tout vérifié.

    Cette règle unique remplace quatre conditions accumulées, chacune ayant révélé l'angle
    mort de la suivante. Elle est validée par table de vérité exhaustive (2 canaris × 7 états
    × 0-2 cas réels)."""
    canary_cases = [c for c in cases if c.get("canary")]
    if not canary_cases:
        return "aucun"
    # Les canaris NON IMPUTABLES sont écartés du jugement : sautés faute de budget global
    # (l'ordre est tiré au sort) ou victimes d'une défaillance du noteur (tmpfs saturé).
    jugeables = [c for c in canary_cases if not outcomes[c["index"]].skipped]
    non_imputables = len(jugeables) < len(canary_cases)
    if not jugeables:
        return "indetermines"
    reels = [c for c in cases if not c.get("canary") and not outcomes[c["index"]].skipped]

    confirmes, accusables = [], []
    for c in jugeables:
        issue = outcomes[c["index"]]
        if issue.ran and issue.passed == (c["canary"] == "pass"):
            confirmes.append(c)                       # CONFIRMÉ
        elif issue.ran or not inconclusive(issue):
            accusables.append(c)                      # non confirmé, et imputable a priori
        # sinon : compilation échouée pour une cause non concluante — règle 2, jamais d'accusation

    if accusables:
        # LE critère : l'étudiant y gagne-t-il ? Sans cas réel vert, faire échouer des canaris
        # ne rapporte rien — accuser ne protégerait donc personne et frapperait un code
        # honnête. C'est aussi ce qui couvre l'échec de compilation global (aucun cas vert).
        if any(outcomes[c["index"]].passed for c in reels):
            event("canari_incoherent",
                  detail="canaris non conformes alors qu'un cas réel a réussi "
                         "— falsification probable")
            return "incoherents"
        return "indetermines"
    # « ok » exige que CHAQUE canari ait été CONFIRMÉ : un canari non compilé pour une cause
    # non concluante n'accuse pas, mais il n'a rien vérifié non plus — répondre « ok »
    # prétendrait le contraire. Idem si l'un était non imputable.
    if non_imputables or len(confirmes) != len(jugeables):
        return "indetermines"
    return "ok"


# En dessous de ce seuil, /box ne peut plus accueillir une compilation : on le traite comme une
# saturation plutôt que de laisser échouer les cas suivants avec un diagnostic trompeur.
BOX_MIN_FREE_BYTES = 48 * 1024 * 1024


def box_exhausted():
    """Le tmpfs /box est-il saturé ? (partagé par tous les cas, compté dans la mémoire du
    conteneur). FONCTION PURE à l'exception de l'appel système — couverte indirectement par
    le test de free_bytes_under."""
    try:
        st = os.statvfs(BOX)
    except OSError:
        return False
    return free_bytes_under(st.f_bavail, st.f_frsize, BOX_MIN_FREE_BYTES)


def free_bytes_under(blocks_available, block_size, threshold):
    """Espace libre (blocs × taille) sous le seuil ? Isolé pour être testable sans montage."""
    return blocks_available * block_size < threshold


def kill_student_survivors():
    """Balaye les processus UID étudiant restés en vie (fork + setsid échappe au killpg du
    timeout) : isolation entre les cas d'une même évaluation. Appelé entre deux cas."""
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/" + pid + "/status", "r") as f:
                for line in f:
                    if line.startswith("Uid:"):
                        if int(line.split()[1]) == STUDENT_UID:
                            os.kill(int(pid), signal.SIGKILL)
                        break
        except (OSError, ValueError):
            continue


def preexec_compile():
    """preexec_fn des compilations du mode evaluate (root) : groupe de processus dédié —
    sans setsid, killpg au timeout échouait (le compilateur partage le pgid du superviseur)
    et proc.wait() bloquait jusqu'au budget mural du conteneur (502 au lieu d'un verdict
    « Échec de compilation »). Pas de rlimits : un binaire de test (debug) peut dépasser
    la borne FSIZE des processus étudiants."""
    os.setsid()


def preexec_root():
    """preexec_fn quand strace (root) encapsule le processus étudiant (-u student).

    Les rlimits posées ici sont HÉRITÉES par le processus étudiant que strace lance
    après son setuid : le chemin strace (nominal) porte donc les mêmes bornes que le
    chemin direct (demote_student). RLIMIT_NPROC ne compte que contre l'UID étudiant
    (root n'est pas limité), et 256 descripteurs suffisent largement à strace."""
    os.setsid()
    resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_LIMIT, FSIZE_LIMIT))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))


def open_output(path):
    """Ouvre un fichier de sortie SANS suivre un lien symbolique : en mode exec, /box
    appartient à l'UID étudiant, qui pouvait remplacer run.out par un lien et faire écrire
    root ailleurs (nuisance dans un conteneur jetable, mais primitive gratuite à supprimer).
    Si le chemin EST un lien, O_NOFOLLOW échoue : on le retire et on recommence — sans ça,
    l'OSError remontait jusqu'en haut et le job entier répondait 502."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    try:
        return os.fdopen(os.open(path, flags, 0o600), "wb")
    except OSError:
        try:
            os.unlink(path)
        except OSError:
            pass
        return os.fdopen(os.open(path, flags, 0o600), "wb")


def drain_pipe(src, dst, cap=OUTPUT_FILE_CAP, tail_bytes=PUMP_TAIL_BYTES,
               etat=None):
    """Recopie un tube du processus exécuté vers son fichier de sortie, côté ROOT.

    MIROIR de read_capped : au-delà du plafond, on garde la TÊTE puis la QUEUE. Tous les
    canaux de verdict sont en FIN de sortie (ligne du jeton, sommaire du framework, verdict
    encadré par nonce du mode exec) ; n'écrire que la tête les perdait, et une copie honnête
    mais bavarde devenait « jeton absent », c'est-à-dire une fausse accusation de triche. La
    queue est tamponnée en RAM dans un deque borné : quelques dizaines de Kio par flux.

    On ne cesse JAMAIS de lire avant l'EOF, et on ne ferme pas le tube : le remplir bloquerait
    le processus, le fermer le tuerait par SIGPIPE. Une erreur d'écriture (tmpfs saturé) fait
    donc passer en lecture seule, pas en fermeture."""
    written = 0
    tail = collections.deque(maxlen=tail_bytes)
    dropped = 0
    writable = True
    tete_ouverte = True
    try:
        while True:
            chunk = src.read(65536)
            if not chunk:
                break
            if writable and tete_ouverte:
                part = chunk[: cap - written]
                if len(part) < len(chunk):
                    # Le plafond tombe DANS ce bloc : la tête se ferme DÉFINITIVEMENT, coupée
                    # à la dernière fin de ligne. Coupée à l'octet près, le marqueur de
                    # troncature scinderait la ligne en cours — et si c'est celle du jeton,
                    # token_exit_code ne la reconnaît plus : fausse accusation de forgeage.
                    # DÉFINITIVEMENT, parce que la coupe laisse written < cap : sans ce
                    # verrou, un bloc suivant assez court repartait dans la tête, qui
                    # devenait discontinue — et le DERNIER bloc, celui qui porte la ligne du
                    # jeton, pouvait s'y retrouver AVANT le marqueur, hors de la fenêtre que
                    # read_capped relit. Même fausse accusation, par un autre chemin.
                    tete_ouverte = False
                    coupe = part.rfind(b"\n")
                    part = part[: coupe + 1] if coupe >= 0 else b""
                try:
                    dst.write(part)
                    written += len(part)
                except (OSError, ValueError):
                    writable = False      # tmpfs saturé / fichier refermé : on continue à LIRE
                    part = b""
                    if etat is not None:
                        etat.perdue = True
                chunk = chunk[len(part):]
            if chunk:
                dropped += len(chunk)
                tail.extend(chunk)
        if writable and dropped:
            kept = bytes(tail)
            dropped -= len(kept)
            # MÊME libellé que read_capped, au mot près : libtest_selection s'en sert pour
            # détecter une sortie tronquée et renoncer alors au filtre.
            marqueur = ("\n… (sortie tronquée au milieu : %d octets)\n"
                        % (written + dropped + len(kept))).encode("utf-8")
            try:
                dst.write(marqueur)
                dst.write(kept)
            except (OSError, ValueError):
                if etat is not None:
                    etat.perdue = True
    except (OSError, ValueError):
        pass          # tube rompu : le processus est mort, rien de plus à lire


def run_proc(cmd, cwd, env, timeout_s, out_path, err_path, preexec, stdin_path=None,
             stdin_data=None):
    """Exécute cmd, sorties vers fichiers, kill du groupe au timeout. → (exit, timed_out).

    Les sorties passent par des TUBES que le superviseur (root) recopie dans les fichiers : le
    processus exécuté NE DOIT PAS tenir de descripteur sur ce que le superviseur relit ensuite.
    Un fichier régulier passé directement en stdout lui en donnait un, inscriptible ET
    POSITIONNABLE (open_output n'ouvre pas en O_APPEND) : lseek+write, pwrite64 ou ftruncate
    permettaient de RÉÉCRIRE après coup des octets déjà émis — la ligne du jeton qui porte le
    verdict et les sommaires des frameworks compris, et sans jamais lire le fichier (sa
    relecture par chemin reste refusée) ni connaître le jeton. Les droits 0600 root ne
    protégeaient rien : ils ne sont vérifiés qu'au open(2). Les octets déjà consommés par root
    sont, eux, hors d'atteinte par construction."""
    # stdin_data : charge utile remise au processus par un TUBE (jamais un fichier). Sert à
    # livrer le JETON de fin à l'enveloppe de Java/C# sans qu'il figure dans un artefact
    # lisible par l'étudiant. Un tube n'est pas repositionnable : une fois l'enveloppe l'ayant
    # lu (première instruction de son main, avant tout chargement de classe étudiante), le code
    # noté qui relit stdin ne voit que l'EOF — il ne peut pas revenir en arrière comme il
    # l'aurait fait sur un fichier régulier (lseek).
    stdin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
    # Descripteur du tube SUIVI À PART : `subprocess.DEVNULL` est un int (-3), donc un
    # isinstance(stdin, int) le prendrait pour un descripteur à fermer (os.close(-3) → OSError
    # avalée par le try de run_proc, qui renvoyait alors « code None » pour TOUT appel).
    token_fd = None
    if stdin_data is not None:
        token_fd, write_fd = os.pipe()
        os.write(write_fd, stdin_data.encode("ascii"))   # quelques octets : jamais bloquant
        os.close(write_fd)                               # EOF immédiat après la charge utile
        stdin = token_fd
    # PAS de `with` sur ces deux fichiers : c'est ROOT qui les écrit depuis le passage aux
    # tubes, donc leur tampon peut contenir des octets non écrits. Sur un /box saturé, le
    # close() implicite du `with` RELÈVE l'OSError que le flush vient de laisser (CPython garde
    # les octets en tampon et refait le flush à la fermeture) — l'exception remplaçait alors la
    # valeur de retour, devenait « Erreur interne du noteur », et sur un CANARI une accusation
    # de falsification pour une simple saturation. On ferme donc soi-même, en avalant l'erreur.
    out = err = None
    etat = ETAT_SORTIE          # état DU CAS en cours, capturé une fois pour toutes
    try:
        out, err = open_output(out_path), open_output(err_path)
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, stdin=stdin, preexec_fn=preexec)
        if token_fd is not None:
            os.close(token_fd)           # tube du jeton : le parent lâche son extrémité
            token_fd = None              # ne pas refermer dans le finally
        elif stdin is not subprocess.DEVNULL:
            stdin.close()
        pumps = [threading.Thread(target=drain_pipe,
                                  args=(proc.stdout, out, OUTPUT_FILE_CAP,
                                        PUMP_TAIL_BYTES, etat), daemon=True),
                 threading.Thread(target=drain_pipe,
                                  args=(proc.stderr, err, OUTPUT_FILE_CAP,
                                        PUMP_TAIL_BYTES, etat), daemon=True)]
        for pump in pumps:
            pump.start()
        try:
            code, timed_out = proc.wait(timeout=timeout_s), False
            if code is not None and code < 0:
                etat.tue_par_signal = True      # subprocess rend -N pour un signal
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                # Pas de groupe dédié (preexec sans setsid) : au moins tuer le processus
                # lui-même, sinon proc.wait() bloque pour toujours et tout le job meurt en 502.
                proc.kill()
            proc.wait()
            code, timed_out = None, True
            etat.expire = True
        # Le processus noté est mort, mais ses DESCENDANTS peuvent encore tenir ses tubes
        # ouverts, et drain_pipe reste alors bloqué dans read() jusqu'à l'EOF. On BALAYE
        # D'ABORD, puisque c'est précisément ce qui libère le tube : attendre avant de balayer
        # coûtait PUMP_JOIN_S (10 s) à CHAQUE exécution laissant un processus d'arrière-plan
        # — system("… &"), ProcessBuilder, exec.Command().Start() : du code étudiant tout à
        # fait ordinaire —, soit deux minutes sur une question à dix cas.
        #
        # Balayer tôt est aussi plus conforme à l'isolation voulue : le verdict ne tient qu'à
        # la sortie du processus noté, déjà émise, et les survivants ne doivent de toute façon
        # pas traverser vers le cas suivant. killpg ET kill_student_survivors : le premier
        # couvre les rejetons root de la compilation, le second ceux qui se sont échappés du
        # groupe par setsid.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        kill_student_survivors()
        echeance = time.monotonic() + PUMP_SWEEP_JOIN_S
        for pump in pumps:
            pump.join(timeout=max(0, echeance - time.monotonic()))
        if any(pump.is_alive() for pump in pumps):
            # Dernier recours : un survivant que ni le groupe ni l'UID étudiant n'ont attrapé.
            # Échéance BORNÉE — un fil encore vivant au fork du Popen suivant est un risque
            # (preexec_fn n'est pas sûr depuis un processus multithreadé), mais pendre ici
            # ferait tuer le conteneur au mur et perdrait TOUTE la notation.
            echeance = time.monotonic() + PUMP_JOIN_S
            for pump in pumps:
                pump.join(timeout=max(0, echeance - time.monotonic()))
        for pump, flux in zip(pumps, (proc.stdout, proc.stderr)):
            # Fermer un tube dont la pompe est ENCORE VIVANTE bloquerait : elle attend dans
            # read() en tenant le verrou du tampon, et close() doit l'acquérir — sans borne, ce
            # qui annulerait le join borné ci-dessus et ferait tuer le conteneur au mur (toute
            # la notation perdue). Le superviseur est éphémère : un descripteur laissé ouvert
            # disparaît avec lui.
            if not pump.is_alive():
                try:
                    flux.close()
                except (OSError, ValueError):
                    pass
        return code, timed_out
    except OSError as e:
        # Un /box saturé fait échouer jusqu'à l'OUVERTURE des fichiers de sortie (ENOSPC sur
        # O_CREAT), et Popen peut lever (fork ENOMEM). Laisser remonter aurait rendu le cas
        # « Erreur interne du noteur » — accusation sur une saturation. On dégrade : pas de
        # sortie, donc pas de verdict « réussi » possible, mais rien d'imputable.
        etat.perdue = True
        event("espace_sature", case=etat.case,
              detail="ouverture des sorties impossible : %r" % e)
        return None, False
    finally:
        # Tube du jeton : si open_output ou Popen a levé (saturation, fork ENOMEM), le
        # descripteur n'a jamais été remis à None plus haut — il fuirait, un par cas en échec.
        if token_fd is not None:
            try:
                os.close(token_fd)
            except OSError:
                pass
        sature = False
        for flux in (out, err):
            if flux is None:
                continue
            try:
                flux.close()
            except OSError:
                sature = True      # une saturation est UNE condition, pas une par flux
        if sature:
            etat.perdue = True
            event("espace_sature", case=etat.case,
                  detail="écriture des sorties impossible")


def student_dir(case_dir, name):
    """Crée un dossier possédé par l'étudiant (sorties, HOME, TMP)."""
    path = os.path.join(case_dir, name)
    os.makedirs(path, exist_ok=True)
    os.chown(path, STUDENT_UID, STUDENT_GID)
    os.chmod(path, 0o700)
    return path


def base_env(case_dir):
    """Environnement de la phase de COMPILATION (root) ; run_student le dérive pour l'étudiant."""
    return {
        # PATH de l'IMAGE (toolchains sous /opt/java, /usr/local/go…), pas une liste codée en dur.
        "PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
        "HOME": os.path.join(case_dir, "home_build"),
        "LANG": "C.UTF-8",
        "GOCACHE": os.path.join(BOX, "gocache"),
        "GOPATH": os.path.join(BOX, "gopath"),
        "GOFLAGS": "-mod=mod",
        "CARGO_HOME": os.path.join(BOX, "cargo"),
        "CARGO_TARGET_DIR": os.path.join(case_dir, "target"),
        "MONO_PATH": "/opt/moodit",
        "RUSTUP_HOME": "/usr/local/rustup",
        "TMPDIR": os.path.join(case_dir, "tmp_build"),
    }


STRACE = shutil.which("strace")
STRACE_OK = None  # SONDÉ au démarrage (probe_strace), jamais déduit d'un run étudiant


def probe_strace():
    """Disponibilité de strace, déterminée par une SONDE ROOT indépendante de tout code
    étudiant (`strace … /bin/true`).

    Elle remplace l'ancienne déduction « premier run tracé → fichier vide ⇒ strace
    inutilisable », qui était CONTRÔLABLE PAR L'ÉTUDIANT : au timeout, run_proc tue le groupe
    (killpg), donc strace lui-même, et son tampon de sortie vers -o pouvait n'avoir jamais été
    écrit → fichier vide → drapeau GLOBAL à False → plus aucune trace pour TOUS les cas
    suivants, donc plus de détection des lectures de binaire (la seule voie d'extraction du
    jeton sur les natifs). Il suffisait de faire expirer le premier cas exécuté — sans même
    connaître l'ordre, une condition sur /proc/uptime (non tracé) y suffit. La sonde ne dépend
    d'aucun run étudiant, et un cas expiré ne désarme plus rien."""
    global STRACE_OK
    if not STRACE:
        STRACE_OK = False
        event("trace_indisponible", detail="strace absent de l'image")
        return False
    trace = os.path.join(BOX, ".strace_probe")
    try:
        # EXACTEMENT le chemin réel, « -u student » compris : si c'est la transition setuid qui
        # échoue (utilisateur absent, setgroups refusé, profil durci), une sonde sans -u
        # réussirait, STRACE_OK resterait vrai, les traces réelles seraient vides et la
        # détection s'éteindrait SANS le moindre trace_indisponible.
        subprocess.run([STRACE, "-f", "-qq", "-e", "trace=openat,open", "-o", trace,
                        "-u", "student", "/bin/true"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        STRACE_OK = os.path.exists(trace) and os.path.getsize(trace) > 0
    except (OSError, subprocess.SubprocessError):
        STRACE_OK = False
    finally:
        try:
            os.unlink(trace)
        except OSError:
            pass
    if not STRACE_OK:
        # Capacité SYS_PTRACE absente : la notation continue, mais lecture_source_tentee et
        # lecture_binaire_tentee sont DÉSARMÉS pour tout le job. L'événement n'appartient à aucun
        # cas, donc il n'est annexé à aucun verdict — en revanche DockerEvaluator journalise TOUS
        # les événements, et celui-ci en ERREUR (c'est une panne d'infrastructure à corriger, pas
        # un fait de notation). Un log côté superviseur n'y ajouterait rien : son stderr n'est
        # relu que si le JSON est illisible, et le conteneur est détruit juste après.
        event("trace_indisponible", detail="strace inutilisable (SYS_PTRACE ?)")
    return STRACE_OK


def run_student(cmd, case_dir, env, timeout_s, tag, stdin_data=None):
    """Exécute `cmd` sous l'UID student (via strace -u si disponible) ; renvoie
    (exit, timed_out, stdout, stderr, trace_path).

    `stdin_data` : charge utile livrée par un TUBE (cf. run_proc) — le jeton de fin pour les
    enveloppes Java/C#, qui n'a ainsi pas à être compilé dans un artefact lisible."""
    if STRACE_OK is None:
        probe_strace()      # sonde paresseuse : aucun appelant ne doit tracer « à l'aveugle »
    out_path = os.path.join(case_dir, tag + ".out")
    err_path = os.path.join(case_dir, tag + ".err")
    # HOME/TMP de la phase de RUN : sous work/, possédés par l'étudiant (séparés du build).
    env = dict(env)
    env["HOME"] = student_dir(os.path.join(case_dir, "work"), "home")
    env["TMPDIR"] = student_dir(os.path.join(case_dir, "work"), "tmp")
    if STRACE and STRACE_OK:
        trace_path = os.path.join(case_dir, tag + ".trace")
        wrapped = [STRACE, "-f", "-qq", "-e", "trace=openat,open,readlink,readlinkat",
                   "-o", trace_path, "-u", "student"] + cmd
        code, timed_out = run_proc(wrapped, case_dir, env, timeout_s, out_path, err_path,
                                   preexec_root, stdin_data=stdin_data)
        return code, timed_out, read_capped(out_path), read_capped(err_path), trace_path
    code, timed_out = run_proc(cmd, case_dir, env, timeout_s, out_path, err_path,
                               demote_student, stdin_data=stdin_data)
    return code, timed_out, read_capped(out_path), read_capped(err_path), None


def scan_trace(trace_path, locked_dir, case_index, binaries=()):
    """Ouverture d'une source verrouillée OU du binaire de test lui-même (langages natifs :
    seule voie d'extraction du jeton de fin) par le processus étudiant = événement.
    Le chemin peut être absolu (/box/cases/<i>/src/…) ou relatif au cwd du cas ("src/…")."""
    if not trace_path or not os.path.exists(trace_path):
        return
    probes = []
    for binary in binaries:
        if binary:
            probes += ['"' + binary + '"', '"./' + os.path.basename(binary) + '"',
                       '"' + os.path.basename(binary) + '"', '"/proc/self/exe"']
    try:
        with open(trace_path, "r", errors="replace") as f:
            for line in f:
                if "openat(" not in line and "open(" not in line and "readlink" not in line:
                    continue
                if locked_dir in line or '"src/' in line or '"./src/' in line:
                    event("lecture_source_tentee", case=case_index, detail=line.strip()[:300])
                    return
                # Binaire : n'accuser que sur une LECTURE RÉUSSIE. Le basename est générique
                # (« tests » pour C/C++/Go), donc une sous-chaîne suffisait à accuser : un
                # étudiant honnête qui écrivait un fichier nommé `tests` dans son dossier (refusé,
                # case_dir est root) portait la bannière « Comportement suspect ». Or lire son
                # binaire RÉUSSIT — c'est tout l'intérêt de l'attaque : exiger le succès retire
                # les faux positifs sans rien céder. Idem pour readlink(/proc/self/exe), que des
                # runtimes honnêtes font au démarrage : seule une OUVERTURE réussie compte.
                if probes and any(p in line for p in probes) and trace_read_ok(line):
                    event("lecture_binaire_tentee", case=case_index, detail=line.strip()[:300])
                    return
    except OSError:
        pass


def trace_read_ok(line):
    """Cette ligne de trace est-elle une OUVERTURE EN LECTURE RÉUSSIE ? FONCTION PURE (testée).

    strace rend « … ) = <fd> » en succès et « … ) = -1 ERRNO (…) » en échec. Une ouverture en
    écriture/création n'est pas une lecture : un fichier homonyme créé par une soumission
    honnête ne doit jamais valoir une accusation."""
    if "open" not in line:
        return False                       # readlink : ne lit aucun contenu
    # O_RDWR LIT aussi : seul O_WRONLY exclut la lecture. (O_CREAT/O_TRUNC/O_APPEND sans
    # O_WRONLY restent des créations, pas des lectures de contenu existant.)
    if "O_WRONLY" in line:
        return False
    if any(flag in line for flag in ("O_CREAT", "O_TRUNC", "O_APPEND")) and "O_RDWR" not in line:
        return False
    resultat = line.rsplit("=", 1)[-1].strip() if "=" in line else ""
    return bool(re.match(r"^\d+", resultat))


def lock_sources(src_dir):
    """Sources (harnais compris) illisibles par l'étudiant — root, 700."""
    for root, dirs, files in os.walk(src_dir):
        for name in dirs + files:
            path = os.path.join(root, name)
            os.chown(path, 0, 0)
            os.chmod(path, 0o700)
    os.chown(src_dir, 0, 0)
    os.chmod(src_dir, 0o700)


def open_artifacts(path):
    """Rend un artefact (binaire / dossier de classes) lisible et exécutable par l'étudiant."""
    if os.path.isdir(path):
        for root, dirs, files in os.walk(path):
            for d in dirs:
                os.chmod(os.path.join(root, d), 0o755)
            for f in files:
                os.chmod(os.path.join(root, f), 0o755)
        os.chmod(path, 0o755)
    elif os.path.exists(path):
        os.chmod(path, 0o755)


def make_traversable(path, top):
    """Rend traversables (755) les dossiers de `path` jusqu'à `top` (exclu)."""
    current = os.path.dirname(path) if os.path.isfile(path) else path
    while current.startswith(top) and current != top:
        os.chmod(current, 0o755)
        current = os.path.dirname(current)


def first_lines(text, pattern, count=6):
    """Les quelques lignes à partir du premier match (détail d'échec lisible)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if re.search(pattern, line):
            return "\n".join(lines[i:i + count])[:1500]
    return None


class CaseOutcome:
    def __init__(self, passed, detail=None, ran=False, timed_out=False, skipped=False,
                 killed=False):
        self.passed = passed
        self.detail = detail
        self.ran = ran  # le run a eu lieu (≠ échec de compilation) — utilisé par les canaris
        self.timed_out = timed_out  # temps limite dépassé — utilisé par le verdict des canaris
        self.skipped = skipped  # cas SAUTÉ faute de budget global (ni tenté, ni fautif)
        self.killed = killed  # mort PAR SIGNAL (OOM, SIGSEGV) — cause non concluante


def inconclusive(outcome):
    """L'échec de ce cas a-t-il une cause NON CONCLUANTE ? FONCTION PURE (testée).

    Temps limite dépassé ou mort par signal : on ne peut rien en déduire sur l'intention.
    Le verdict des canaris s'en sert pour ne pas accuser — wrapper_verdict prend déjà soin
    de ne pas accuser un processus tué après les tests, et canary_verdict défaisait cette
    précaution par l'autre porte."""
    return outcome.timed_out or outcome.killed


# Nom du test canari tiré au sort, par index de cas (vide pour un cas réel). Sert à
# N'EXÉCUTER QUE LUI dans un cas canari : le code étudiant y est compilé, donc SES PROPRES
# tests unitaires (idiome courant en Rust/Java/C#) étaient découverts et exécutés — un test
# d'étudiant simplement FAUX faisait échouer le canari « pass », et toute la soumission était
# refusée pour « falsification probable ». Les init/constructeurs du code étudiant tournent
# toujours au chargement : le forgeage qu'il s'agit d'attraper reste détecté.
CANARY_NAMES = {}

# Conteneurs de tests déclarés par le CODE ÉTUDIANT, par index de cas (Java/C#/Rust) : ils
# sont EXCLUS de l'exécution. Le code étudiant est compilé dans la même unité que le harnais,
# donc ses PROPRES tests unitaires étaient comptés dans le verdict — un test d'étudiant
# simplement faux mettait la question à 0. Exclure plutôt que sélectionner est un choix de
# SÛRETÉ : une extraction incomplète ne peut que réintroduire ce défaut d'équité, jamais
# n'exécuter aucun test du prof et offrir la note. Liste vide = comportement d'origine.
STUDENT_TYPES = {}

# Conteneurs de tests déclarés par le HARNAIS, par index de cas. Ils portent l'invariant de
# sûreté : pour qu'un cas soit RÉUSSI, au moins un test exécuté doit leur appartenir.
#
# Un comptage anonyme (« au moins un test a tourné ») ne suffisait pas : l'exclusion est
# construite à partir d'un texte que l'ÉTUDIANT contrôle, et dès qu'elle emportait le harnais,
# un seul test personnel survivant au filtre suffisait à faire noter le cas « réussi » sur un
# code arbitrairement faux. Vérifier l'appartenance rend l'extraction non critique : elle
# n'optimise que l'ÉQUITÉ, elle ne décide plus de l'intégrité de la note.
#
# Liste vide = harnais non identifié : aucune exclusion n'est appliquée (tous ses tests
# tournent donc) et l'invariant n'a rien à vérifier.
HARNESS_TYPES = {}

# Jeton de fin d'exécution par cas (substitué dans les sources, imprimé après tous les tests).
TOKENS = {}


def token_exit_code(stdout, case_index):
    """Code de sortie du framework tel que l'ENVELOPPE DE CONFIANCE l'a publié, sur la ligne du
    jeton, après l'exécution des tests. FONCTION PURE (testée). → entier, ou None si la ligne
    est absente (jeton non atteint, ou enveloppe sans code — cas non concerné).

    C'est la SEULE voie de confiance pour le verdict des langages à enveloppe. Les deux autres
    canaux sont sous le contrôle de l'étudiant APRÈS l'impression du jeton : le rapport du
    framework vit sous work/ (possédé par l'étudiant) et le code de sortie du processus
    s'écrase après coup. Une ligne déjà CONSOMMÉE PAR ROOT, non : stdout passe par un tube que
    run_proc recopie, le fichier relu n'est jamais confié au processus noté. Forger cette ligne
    suppose donc de connaître le jeton — le résiduel déjà documenté (lecture en-processus),
    rien de moins."""
    token = TOKENS.get(case_index)
    if not token:
        return None
    codes = re.findall(r"\[MOODIT\] jeton=" + re.escape(token) + r" code=(-?\d+)", stdout)
    if len(codes) == 1:
        return int(codes[0])
    if codes:
        # L'enveloppe n'en imprime qu'UNE. Plusieurs = une autre a été produite depuis le code
        # noté, donc le jeton a fuité : on ne choisit pas entre elles, on refuse.
        event("jeton_duplique", case=case_index,
              detail="plusieurs lignes de jeton — verdict forgé probable")
    return None


def redact_tokens(detail):
    """Retire TOUT jeton du détail renvoyé à l'appelant. FONCTION PURE (testée).

    Le détail est construit à partir des premières lignes de la sortie du cas : quand le
    verdict échoue tôt, la ligne `[MOODIT] jeton=… code=…` s'y retrouvait telle quelle et
    repartait vers core (journaux, détail affiché au prof). Un jeton ne vaut que pour SON cas
    et SON conteneur, donc l'exposition est bornée — mais un secret de notation n'a rien à
    faire dans un message, et les détails pourraient un jour être montrés à l'étudiant."""
    if not detail:
        return detail
    nettoye = detail
    for token in TOKENS.values():
        if token:
            nettoye = nettoye.replace(token, "…")
    return nettoye


def token_exit_code_either(stdout, stderr, case_index):
    """Code publié par l'enveloppe, cherché sur STDOUT puis sur STDERR. FONCTION PURE (testée).

    L'enveloppe publie sa ligne de verdict sur les DEUX descripteurs bruts : un étudiant
    honnête qui ferme System.out (`try (PrintWriter w = new PrintWriter(System.out))`, idiome
    banal) fermait sinon le fd 1 du processus, la ligne disparaissait, et une RÉPONSE JUSTE
    recevait « ⚠ jeton_absent » — une accusation de triche pour un idiome de première année.
    On prend la première source qui donne un code. Un flux qui porte une ligne de jeton SANS
    en tirer de code (doublon → jeton_duplique, ou forme incomplète) vaut REFUS : on ne se
    rattrape pas sur l'autre flux, sinon il suffisait de dupliquer la ligne sur stdout pour
    faire ignorer le refus et se faire noter sur celle de stderr."""
    token = TOKENS.get(case_index)
    if not token:
        return None
    for flux in (stdout, stderr):
        code = token_exit_code(flux, case_index)
        if code is not None:
            return code
        if ("[MOODIT] jeton=" + token) in flux:
            return None
    return None


def wrapper_verdict(framework_code, looked_ok, detail, case_index, exit_code=0,
                    sortie_perdue=False):
    """Verdict d'un langage À ENVELOPPE (Java, C#, Go) → (passed, détail).

    {@code framework_code} : code publié par l'enveloppe SUR LA LIGNE DU JETON (voir
    token_exit_code). {@code looked_ok} : tout le reste semblait cohérent (rapport exploitable,
    tests comptés, aucun échec signalé). {@code exit_code} : code de sortie du PROCESSUS.

    Les deux codes sont exigés ENSEMBLE, et c'est strictement plus fort que l'un ou l'autre :
    - substituer la ligne du jeton au code de sortie AFFAIBLIRAIT Go, où tout le verdict vient
      alors de stdout — or `os.Stdout` y est une variable de paquet, réassignable depuis un
      `init()` du fichier étudiant (même `package main` que l'enveloppe), donc la sortie est
      réécrivable EN VOL sans jamais connaître le jeton ;
    - s'en tenir au code de sortie laissait Java et C# forgeables, lui étant écrasable après
      l'impression du jeton (halt(0) dans un hook d'arrêt, thread de premier plan).
    Exiger les deux ne coûte rien à une soumission honnête : l'enveloppe sort avec le code
    qu'elle vient de publier.

    Ligne du jeton ABSENTE alors que tout le reste semble bon = signature d'une sortie forgée
    avant la fin des tests : le cas échoue ET l'événement est levé, pour que le prof le voie.
    Sans cet aiguillage, le refus arriverait silencieusement par le verdict seul."""
    if framework_code == 0 and looked_ok and exit_code == 0:
        return True, None
    if framework_code is None and looked_ok and exit_code == 0 and not sortie_perdue:
        # exit_code == 0 EXIGÉ : c'est la signature du forgeage (un exit(0)/halt(0) posé après
        # les tests). Un processus TUÉ après la fin des tests — OOM du cgroup, SIGXFSZ, signal —
        # laisse aussi un rapport crédible sans ligne de jeton, mais sort avec un code non nul :
        # l'accuser de triche serait une fausse accusation sur une soumission honnête.
        # sortie_perdue : si le tmpfs a saturé, la ligne du jeton a pu ne jamais être ÉCRITE
        # alors que le rapport sous work/ l'était déjà — même fausse accusation, autre cause.
        event("jeton_absent", case=case_index,
              detail="sortie sans jeton de fin d'exécution — rapport forgé probable")
        return False, "Échec du harnais (jeton de fin d'exécution absent ou incohérent)"
    return False, detail


def enforce_token(passed, detail, stdout, case_index, sortie_perdue=False):
    """Un verdict « réussi » exige le jeton de fin d'exécution dans la sortie : il n'est imprimé
    qu'APRÈS tous les tests par le point de sortie du framework — un rapport forgé suivi d'un
    exit(0) depuis le code étudiant ne l'a pas. Absent alors que tout le reste est cohérent :
    échec + événement."""
    token = TOKENS.get(case_index)
    if not passed or not token or ("[MOODIT] jeton=" + token) in stdout:
        return passed, detail
    if sortie_perdue:
        # Sortie non écrite (tmpfs saturé) : le jeton a pu ne jamais atteindre le fichier.
        # Le cas échoue, mais sans accusation — on ne distingue pas une saturation d'un
        # forgeage, et dans le doute on n'accuse pas.
        return False, "Échec du harnais (sortie incomplète)"
    event("jeton_absent", case=case_index,
          detail="sortie sans jeton de fin d'exécution — rapport forgé probable")
    return False, "Échec du harnais (jeton de fin d'exécution absent)"


def prep_run(case_dir, src):
    """Après compilation : sources ET caches de build verrouillés — gocache, dépôt cargo,
    target, HOME/TMP de compilation contiennent des copies des sources substituées (jeton,
    canaris), leur lecture par l'étudiant serait une extraction silencieuse. Les artefacts à
    exécuter sont rouverts ensuite (open_artifacts / chmod du binaire)."""
    lock_sources(src)
    for cache in (os.path.join(BOX, "gocache"), os.path.join(BOX, "cargo"),
                  os.path.join(case_dir, "target"), os.path.join(case_dir, "home_build"),
                  os.path.join(case_dir, "tmp_build")):
        if os.path.isdir(cache):
            lock_sources(cache)
    os.chmod(case_dir, 0o755)
    os.chmod(os.path.join(BOX, "cases"), 0o755)
    student_dir(case_dir, "work")


# ────────────────────────── langages ──────────────────────────
# Chaque runner : (CaseOutcome, None) après run, ou (None, détail) si la compilation échoue.
# Le verdict d'un run est FAIL-CLOSED : exit 0 ET marqueurs du framework cohérents ET ≥ 1 test.

def c_family(case_dir, env, timeout_s, case_index, compiler, std, ext):
    src = os.path.join(case_dir, "src")
    tests_bin = os.path.join(case_dir, "tests")
    code, timed_out = run_proc(
        [compiler, std, "-O1", "-I/opt/moodit", os.path.join(src, "harness." + ext),
         "-o", tests_bin, "-lm"],
        case_dir, env, COMPILE_TIMEOUT_S,
        os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"), preexec_compile)
    if timed_out or code != 0:
        return None, "Échec de compilation :\n" + read_capped(os.path.join(case_dir, "cc.err"))[:1500]
    prep_run(case_dir, src)
    open_artifacts(tests_bin)
    exit_code, t_out, stdout, stderr, trace = run_student([tests_bin], case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index, binaries=(tests_bin,))
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    # C/C++ : pas d'enveloppe qui tienne le code de sortie du framework (le jeton est imprimé
    # par moodit_check.h), donc le verdict reste sur exit_code + sommaire — mais un sommaire
    # PORTEUR DU JETON, et unique (voir c_summary). L'interposition de printf reste le résiduel
    # assumé et documenté pour ces deux langages.
    # stdout PUIS stderr (moodit_check.h publie sur les deux) : un `fclose(stdout)` d'un
    # étudiant honnête ne doit pas faire disparaître le verdict ni valoir une accusation.
    # Toute la décision vit dans c_verdict, testée (dont le refus sans repli après un doublon).
    total, failed, forge, incident = c_verdict(stdout, stderr, TOKENS.get(case_index), case_index)
    coherent = total is not None and total > 0
    passed = exit_code == 0 and coherent and failed == 0
    if passed and first_lines(stdout, r"^\[MOODIT\] fail "):
        # Fil de détente, miroir de celui de Rust : des lignes d'échec alors que le sommaire
        # authentique annonce zéro échec = mise en forme incohérente, on refuse sans accuser.
        passed = False
        event("rapport_incoherent", case=case_index,
              detail="lignes d'échec malgré un sommaire sans échec")
    if exit_code == 0 and not coherent and incident is None:
        # `incident` déjà signalé (sommaire dupliqué) : un second événement n'ajouterait rien,
        # et le libellé « sommaire forgé » qualifierait à tort une soumission honnête.
        event("rapport_incoherent", case=case_index,
              detail="sommaire forgé (jeton absent)" if forge else "exit 0 sans sommaire moodit_check")
    detail = None if passed else (
            "Verdict indisponible : le sommaire du framework a été imprimé plusieurs fois "
            "(processus dupliqué ?)" if incident is not None
            else first_lines(stdout, r"^\[MOODIT\] fail ")
                 or first_lines(stderr, r".")
                 or ("Sommaire de test non authentifié : ignoré (le sommaire du "
                     "framework n'a pas été produit)" if forge and not coherent
                     else "Échec du harnais"))
    passed, detail = enforce_token(passed, detail, stdout + "\n" + stderr, case_index,
                                   ETAT_SORTIE.perdue)
    return CaseOutcome(passed, detail, ran=True), None


def c_summary(stdout, token):
    """Sommaire de moodit_check.h → (total, failed, forge, sommaires). FONCTION PURE (testée).

    Seul un sommaire PORTEUR DU JETON compte : le code noté ne peut pas en produire sans
    connaître le jeton (harnais illisible, lecture du binaire tracée). Et il en faut
    EXACTEMENT UN — sinon le cas est refusé SANS accusation (`sommaire_duplique`, cf.
    `c_verdict` : un processus dupliqué suffit à en produire deux). Retenir le premier match
    laissait le code noté en imprimer un faux AVANT la fin, puis laisser le framework finir
    normalement (vrai sommaire, vrai jeton) et sortir en 0 par atexit().

    `forge` : vrai si un sommaire SANS jeton a été vu — signe d'un faux, mais non imputable
    (une soumission peut imprimer n'importe quoi), donc jamais une accusation.
    Quatrième valeur : la LISTE des sommaires authentifiés trouvés dans ce flux, `[]` si aucun.
    Rendue telle quelle (et non réduite à un booléen « doublon ») parce que l'appelant doit
    distinguer trois situations : aucun sommaire → tenter l'autre flux ; un seul → verdict ;
    plusieurs → REFUS sans se rabattre sur l'autre flux, sans quoi dupliquer la ligne sur stdout
    suffisait à faire annuler le refus par la relecture de stderr.
    """
    forge = bool(re.search(r"^\[MOODIT\] summary total=", stdout, re.M))
    if not token:
        return None, None, forge, []
    matches = [(int(t), int(f)) for t, f in
               re.findall(r"^\[MOODIT\] summary jeton=" + re.escape(token)
                          + r" total=(\d+) failed=(\d+)$", stdout, re.M)]
    if len(matches) != 1:
        # `forge` garde son sens STRICT : « un sommaire sans jeton a été vu ». Y agréger le
        # doublon faisait libeller un refus honnête « sommaire forgé (jeton absent) » dans les
        # journaux — l'accusation même qu'on cherchait à retirer, déplacée du verdict au log.
        return None, None, forge, matches
    return matches[0][0], matches[0][1], forge, matches


def c_verdict(stdout, stderr, token, case_index):
    """Décision du chemin C/C++ → (total, failed, forge, incident). Lève l'événement qui convient.

    Isolée de `c_family` (intestable : compilation + run_student) parce que c'est ICI que vit la
    propriété de sécurité, et qu'elle a besoin d'un filet : remettre un repli sur stderr après un
    doublon — l'exploit même — laissait toute la suite verte.

    Deux sommaires authentifiés dans un flux = le framework n'en imprime qu'un par flux. Le cas
    est REFUSÉ, mais JAMAIS accusé — quelle que soit la concordance des deux sommaires :
    `moodit_check.h` imprime le sommaire APRÈS la boucle de tests, donc un `fork()` dans la
    fonction notée dont l'enfant revient normalement poursuit la boucle et imprime SON sommaire
    (code honnête, exercice sur les appels système). Et comme l'enfant reprend la boucle avec son
    propre état, ses tests restants peuvent donner un autre `failed` : la DIVERGENCE n'est donc
    pas une preuve de fuite non plus — « deux processus du binaire » et « jeton extrait » ne se
    départagent pas ici, et refuser suffit dans les deux cas (personne ne gagne rien). D'où
    `sommaire_duplique`, volontairement absent d'`isSuspicious` côté Java : règle du projet, dans
    le doute on refuse mais on n'accuse pas. La forge « sommaire imprimé tôt + `atexit(0)` »
    reste fermée par l'exigence d'UNICITÉ elle-même, et le fil de détente `[MOODIT] fail` reste
    en place pour les incohérences de mise en forme.
    """
    total, failed, forge, sommaires = c_summary(stdout, token)
    if not sommaires:
        total, failed, forge_err, sommaires = c_summary(stderr, token)
        forge = forge or forge_err
    if len(sommaires) > 1:
        event("sommaire_duplique", case=case_index,
              detail="sommaire authentifié imprimé plusieurs fois (processus dupliqué ?)")
        return None, None, forge, "sommaire_duplique"
    return total, failed, forge, None


def run_c(case_dir, env, timeout_s, case_index):
    return c_family(case_dir, env, timeout_s, case_index, "gcc", "-std=c17", "c")


def run_cpp(case_dir, env, timeout_s, case_index):
    return c_family(case_dir, env, timeout_s, case_index, "g++", "-std=c++20", "cpp")


def run_java(case_dir, env, timeout_s, case_index):
    src = os.path.join(case_dir, "src")
    classes = os.path.join(case_dir, "classes")
    os.makedirs(classes, exist_ok=True)
    junit = "/opt/moodit/junit-console.jar"
    sources = glob.glob(os.path.join(src, "*.java"))
    code, timed_out = run_proc(
        ["javac", "-encoding", "UTF-8", "-cp", junit, "-d", classes] + sources,
        case_dir, env, COMPILE_TIMEOUT_S,
        os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"), preexec_compile)
    if timed_out or code != 0:
        return None, "Échec de compilation :\n" + read_capped(os.path.join(case_dir, "cc.err"))[:1500]
    prep_run(case_dir, src)
    open_artifacts(classes)
    reports = os.path.join(case_dir, "work", "reports")
    # Forme -cp + ConsoleLauncher (― pas `-jar`, qui fige le classpath au seul jar) et
    # --include-classname=.* : sans lui, seules les classes nommées *Test*/*Tests sont découvertes.
    def launch(selection):
        shutil.rmtree(reports, ignore_errors=True)
        return run_student(
            ["java", "-XX:MaxRAMPercentage=50",
             # Accès natif REFUSÉ (JNI, FFM) : c'est une voie, depuis du code Java, pour
             # dup2() par-dessus le descripteur 1 et intercepter la ligne de verdict que
             # l'enveloppe y publie. Aucun harnais légitime n'en a besoin.
             "--illegal-native-access=deny",
             # sun.misc.Unsafe : l'AUTRE voie, que le drapeau ci-dessus ne couvre pas
             # (jdk.unsupported ouvre sun.misc, et JDK 25 se contente d'un avertissement).
             # putInt(FileDescriptor.out, offset("fd"), …) suffisait à détourner le fd 1.
             "--sun-misc-unsafe-memory-access=deny",
             "-Djava.io.tmpdir=" + os.path.join(case_dir, "work", "tmp"),
             # MooditMain (généré par HarnessProjects) enveloppe le ConsoleLauncher : il imprime
             # le jeton de fin APRÈS l'exécution — un System.exit(0) forgé le saute.
             "-cp", junit + ":" + classes, "MooditMain",
             "execute"] + selection + ["--include-classname=.*",
             "--fail-if-no-tests", "--disable-banner", "--details=summary",
             "--reports-dir", reports],
            case_dir, env, timeout_s, "run",
            # Jeton livré par TUBE : l'enveloppe le lit avant de charger la moindre classe
            # étudiante. Compilé dans classes/*.class (que la JVM doit pouvoir lire sous l'UID
            # étudiant), il était extractible sans aucune trace possible.
            stdin_data=(TOKENS.get(case_index) or "") + "\n")

    def junit_report():
        tests = failures = 0
        xml_ok = False
        containers = []
        for report in glob.glob(os.path.join(reports, "TEST-*.xml")):
            try:
                root = ET.parse(report).getroot()
                tests += int(root.get("tests", "0"))
                failures += int(root.get("failures", "0")) + int(root.get("errors", "0"))
                containers += [tc.get("classname") for tc in root.iter("testcase")
                               if tc.get("classname")]
                xml_ok = True
            except (ET.ParseError, OSError):
                pass
        return tests, failures, xml_ok, containers

    exit_code, t_out, stdout, stderr, trace = launch(junit_selection(case_index))
    tests, failures, xml_ok, containers = (0, 0, False, []) if t_out else junit_report()
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    # Le verdict vient de la ligne du JETON, pas du code de sortie du processus ni du seul
    # rapport XML : ces deux-là sont forgeables depuis le code étudiant après les tests.
    # Le XML ne sert plus qu'au décompte, au détail et à l'invariant « un test du harnais a
    # tourné » — le forger n'avance à rien si le code publié n'est pas 0.
    framework_code = token_exit_code_either(stdout, stderr, case_index)
    looked_ok = xml_ok and tests > 0 and failures == 0
    if framework_code == 0 and looked_ok \
            and not harness_ran(containers, HARNESS_TYPES.get(case_index) or []):
        event("harnais_non_execute", case=case_index,
              detail="aucun test du harnais n'a été exécuté")
        return CaseOutcome(False, "Aucun test du harnais n'a été exécuté", ran=True), None
    if framework_code == 0 and (not xml_ok or tests == 0):
        event("rapport_incoherent", case=case_index, detail="exit 0 sans rapport JUnit exploitable")
    detail = (first_lines(stdout, r"MethodSource|expected|Failures")
              or first_lines(stderr, r".") or "Échec du harnais JUnit")
    passed, detail = wrapper_verdict(framework_code, looked_ok, detail,
                                     case_index, exit_code, ETAT_SORTIE.perdue)
    return CaseOutcome(passed, detail, ran=True), None


def run_csharp(case_dir, env, timeout_s, case_index):
    src = os.path.join(case_dir, "src")
    exe = os.path.join(case_dir, "tests.exe")
    sources = glob.glob(os.path.join(src, "*.cs"))
    code, timed_out = run_proc(
        ["mcs", "-r:/opt/moodit/nunit.framework.dll", "-r:/opt/moodit/nunitlite.dll",
         "-main:MooditRunner", "-out:" + exe] + sources,
        case_dir, env, COMPILE_TIMEOUT_S,
        os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"), preexec_compile)
    if timed_out or code != 0:
        return None, ("Échec de compilation :\n"
                      + (read_capped(os.path.join(case_dir, "cc.err"))
                         or read_capped(os.path.join(case_dir, "cc.out")))[:1500])
    prep_run(case_dir, src)
    open_artifacts(exe)
    result_xml = os.path.join(case_dir, "work", "nunit.xml")

    def nunit_report():
        try:
            root = ET.parse(result_xml).getroot()
            # « total » = tests EXÉCUTÉS ; « testcasecount » = tests DÉCOUVERTS. Avec le
            # second, un filtre qui écarte tout donnait result="Passed", testcasecount>0 et
            # exit 0 : le cas était noté réussi alors qu'AUCUN test n'avait tourné.
            containers = [tc.get("classname") for tc in root.iter("test-case")
                          if tc.get("classname") and tc.get("result") in ("Passed", "Failed")]
            return root.get("result") == "Passed", int(root.get("total", "0")), containers
        except (ET.ParseError, OSError):
            return None, 0, []

    exit_code, t_out, stdout, stderr, trace = run_student(
        ["mono", exe, "--result:" + result_xml] + nunit_selection(case_index),
        case_dir, env, timeout_s, "run",
        stdin_data=(TOKENS.get(case_index) or "") + "\n")   # cf. run_java : jeton hors artefact
    xml_passed, total, containers = (None, 0, []) if t_out else nunit_report()
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    framework_code = token_exit_code_either(stdout, stderr, case_index)   # cf. run_java
    looked_ok = xml_passed is True and total > 0
    if framework_code == 0 and looked_ok \
            and not harness_ran(containers, HARNESS_TYPES.get(case_index) or []):
        event("harnais_non_execute", case=case_index,
              detail="aucun test du harnais n'a été exécuté")
        return CaseOutcome(False, "Aucun test du harnais n'a été exécuté", ran=True), None
    if framework_code == 0 and xml_passed is not True:
        event("rapport_incoherent", case=case_index, detail="exit 0 sans rapport NUnit « Passed »")
    detail = (first_lines(stdout, r"Failed|Error|Exception")
              or first_lines(stderr, r".") or "Échec du harnais NUnit")
    passed, detail = wrapper_verdict(framework_code, looked_ok, detail,
                                     case_index, exit_code, ETAT_SORTIE.perdue)
    return CaseOutcome(passed, detail, ran=True), None


def run_go(case_dir, env, timeout_s, case_index):
    src = os.path.join(case_dir, "src")
    tests_bin = os.path.join(case_dir, "tests")
    code, timed_out = run_proc(
        ["go", "test", "-count=1", "-c", "-o", tests_bin, "."],
        src, env, COMPILE_TIMEOUT_S,
        os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"), preexec_compile)
    if timed_out or code != 0:
        return None, ("Échec de compilation :\n"
                      + (read_capped(os.path.join(case_dir, "cc.err"))
                         or read_capped(os.path.join(case_dir, "cc.out")))[:1500])
    prep_run(case_dir, src)
    open_artifacts(tests_bin)
    exit_code, t_out, stdout, stderr, trace = run_student(
        [tests_bin, "-test.v", "-test.count=1"], case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index, binaries=(tests_bin,))
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    ran_tests = len(re.findall(r"^=== RUN\s", stdout, re.M))
    coherent = re.search(r"^PASS$", stdout, re.M) is not None and ran_tests > 0
    # Ancré sur la ligne de libtest (« --- FAIL: TestX (0.00s) ») : un « FAIL » nu imprimé
    # par le programme de l'étudiant faisait échouer un cas honnête. Un vrai échec donne de
    # toute façon un code de sortie non nul, déjà exigé ci-dessous.
    failed = re.search(r"^--- FAIL: \S", stdout, re.M) is not None
    framework_code = token_exit_code_either(stdout, stderr, case_index)   # cf. run_java
    looked_ok = coherent and not failed
    if framework_code == 0 and not coherent:
        event("rapport_incoherent", case=case_index, detail="exit 0 sans sommaire PASS de go test")
    detail = (first_lines(stdout, r"_test\.go:\d+:|^--- FAIL|panic:")
              or first_lines(stderr, r".") or "Échec du harnais go test")
    passed, detail = wrapper_verdict(framework_code, looked_ok, detail,
                                     case_index, exit_code, ETAT_SORTIE.perdue)
    return CaseOutcome(passed, detail, ran=True), None


# Marqueur de DÉBUT de test imprimé par libtest. Avec --nocapture (requis pour que le jeton
# apparaisse), il n'est PAS suivi d'un saut de ligne : la sortie du test s'y colle, et le
# verdict (« ok » / « FAILED ») atterrit où il peut — parfois seul sur sa ligne.
RUST_TEST_START = re.compile(r"test \S+ \.\.\. ")
# « FAILED » de libtest, quelle que soit sa position : collé au marqueur de début, ou seul sur
# sa ligne quand la sortie du test s'est terminée par un saut de ligne.
RUST_FAILED = re.compile(r"(?m)(?:^|\.\.\. )FAILED\s*$")
RUST_SUMMARY = re.compile(
    r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", re.M)


def rust_verdict(exit_code, stdout, min_tests=2):
    """Verdict d'un cas Rust — FONCTION PURE (couverte par test_supervisor.py).
    → (passed, incohérence ou None).

    {@code min_tests} : nombre MINIMAL de tests exécutés. Le jeton en est un ; un cas réel
    comme un canari en exécutent donc au moins DEUX. C'est l'invariant de sûreté qui ne dépend
    pas de la qualité du filtrage : si une exclusion trop large écartait tous les tests du
    prof, il ne resterait que le jeton — sommaire cohérent, exit 0, jeton présent — et le cas
    aurait été noté RÉUSSI sur un code arbitrairement faux.

    Le jeton Rust est un simple #[test] : un test étudiant trié APRÈS lui (zzzzz_*) peut
    imprimer un sommaire « ok » forgé puis exit(0), alors que le jeton est déjà sorti et que
    les canaris (qui n'appellent pas la fonction notée) restent honnêtes. DEUX recoupements
    ferment ce canal, et aucun ne dépend de la mise en forme exacte :
      1. le « FAILED » que libtest imprime pour le VRAI test raté est dans la sortie, et
         l'étudiant ne peut pas l'empêcher — un sommaire « 0 failed » qui le contredit est forgé ;
      2. le nombre de tests DÉMARRÉS doit égaler le total annoncé par le sommaire : un forgeur
         qui sort avant la fin en annonce moins qu'il n'en a démarré.
    """
    summary = RUST_SUMMARY.search(stdout)
    if exit_code != 0:
        return False, None
    if summary is None:
        return False, "exit 0 sans sommaire cargo test"
    ok, n_passed, n_failed, n_ignored = (summary.group(1), int(summary.group(2)),
                                         int(summary.group(3)), int(summary.group(4)))
    if n_passed + n_failed == 0:
        return False, "exit 0 sans sommaire cargo test"
    if n_passed + n_failed < min_tests:
        return False, ("un seul test exécuté (le jeton) : aucun test du harnais n'a tourné — "
                       "filtrage trop large ou harnais sans test")
    if RUST_FAILED.search(stdout) and n_failed == 0:
        return False, ("« FAILED » dans la sortie malgré un sommaire « 0 failed » — "
                       "sommaire forgé probable")
    started = len(RUST_TEST_START.findall(stdout))
    if started > n_passed + n_failed + n_ignored:
        return False, ("%d tests démarrés pour %d annoncés par le sommaire — "
                       "sortie tronquée ou sommaire forgé" % (started, n_passed + n_failed + n_ignored))
    return ok == "ok" and n_failed == 0, None


def run_rust(case_dir, env, timeout_s, case_index):
    src = os.path.join(case_dir, "src")  # projet cargo complet (Cargo.toml + src/lib.rs)
    build_out = os.path.join(case_dir, "cc.out")
    code, timed_out = run_proc(
        ["cargo", "test", "--offline", "--no-run", "--message-format=json"],
        src, env, COMPILE_TIMEOUT_S, build_out, os.path.join(case_dir, "cc.err"), preexec_compile)
    if timed_out or code != 0:
        err = read_capped(os.path.join(case_dir, "cc.err"))
        human = first_lines(err, r"error(\[|:)", 12) or err[:1500]
        return None, "Échec de compilation :\n" + human
    tests_bin = None
    # Lecture EN FLUX (pas read_capped) : un code riche en warnings peut pousser la ligne
    # compiler-artifact au-delà de tout plafond — la tronquer donnait « binaire introuvable »
    # pour un code qui compile.
    try:
        with open(build_out, "r", errors="replace") as f:
            for line in f:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if (msg.get("reason") == "compiler-artifact" and msg.get("profile", {}).get("test")
                        and msg.get("executable")):
                    tests_bin = msg["executable"]
    except OSError:
        pass
    if not tests_bin or not os.path.exists(tests_bin):
        return None, "Binaire de test introuvable après compilation"
    prep_run(case_dir, src)
    os.chmod(tests_bin, 0o755)
    make_traversable(tests_bin, case_dir)
    # Inventaire des tests du binaire (sous l'UID étudiant) : sert à sélectionner par nom
    # exact ceux qui n'appartiennent pas à un module de l'étudiant.
    listing = ""
    if STUDENT_TYPES.get(case_index):
        # Temps limite COURT : un inventaire honnête prend moins d'une seconde, et ce run
        # s'ajoute au pire cas du cas. Avec le temps limite complet, un cas Rust pouvait
        # coûter « compilation + 2 × perRun » alors que DockerEvaluator n'en budgète qu'un :
        # un cas lancé juste avant l'échéance dépassait le mur du conteneur, et TOUS les
        # verdicts du job étaient perdus. Un dépassement retombe proprement sur « pas de
        # filtre » ci-dessous.
        _, listing_timed_out, listing, _, listing_trace = run_student(
            [tests_bin, "--list"], case_dir, env, min(timeout_s, LIST_TIMEOUT_S), "list")
        # Ce run exécute du code étudiant (un constructeur .init_array tourne avant main) :
        # sa trace doit être dépouillée comme celle de la notation, sinon une lecture du
        # binaire ou des sources verrouillées s'y ferait sans lever d'événement.
        scan_trace(listing_trace, src, case_index, binaries=(tests_bin,))
        # Un listing TRONQUÉ (sortie plafonnée) perdrait les tests du milieu : construire un
        # filtre dessus pouvait écarter le harnais sans qu'on le sache. On renonce alors au
        # filtre — tous les tests tournent, l'équité est perdue mais pas l'intégrité.
        listing = usable_listing(listing, listing_timed_out)
    exit_code, t_out, stdout, stderr, trace = run_student(
        [tests_bin, "--test-threads=1", "--nocapture"] + libtest_selection(case_index, listing),
        case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index, binaries=(tests_bin,))
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    passed, incoherence = rust_verdict(exit_code, stdout)
    if passed and not harness_ran(libtest_ran_tests(stdout), HARNESS_TYPES.get(case_index) or []):
        event("harnais_non_execute", case=case_index,
              detail="aucun test du harnais n'a été exécuté")
        return CaseOutcome(False, "Aucun test du harnais n'a été exécuté", ran=True), None
    if incoherence:
        event("rapport_incoherent", case=case_index, detail=incoherence)
    # --nocapture (requis pour le jeton) : les messages de panique partent sur STDERR au fil de
    # l'eau — on les y cherche d'abord, la liste `failures:` de stdout est maigre sans eux.
    detail = None if passed else (first_lines(stderr, r"panicked at")
                                  or first_lines(stdout, r"panicked at|^failures:|^---- ")
                                  or first_lines(stderr, r".") or "Échec du harnais cargo test")
    passed, detail = enforce_token(passed, detail, stdout + "\n" + stderr, case_index,
                                   ETAT_SORTIE.perdue)
    return CaseOutcome(passed, detail, ran=True), None


RUNNERS = {
    "c": run_c,
    "cpp": run_cpp,
    "java": run_java,
    "csharp": run_csharp,
    "go": run_go,
    "rust": run_rust,
}


def substitute_placeholders(case_dir, mapping):
    """Remplace les gabarits (__MOODIT_A__/__MOODIT_B__ des canaris, __MOODIT_T__ du jeton)
    dans les sources du cas par les valeurs tirées au sort."""
    for root, _, files in os.walk(os.path.join(case_dir, "src")):
        for name in files:
            path = os.path.join(root, name)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            if any(key in content for key in mapping):
                for key, value in mapping.items():
                    content = content.replace(key, value)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)


def execute_case(language, case, timeout_s):
    # État de capture NEUF pour ce cas (voir EtatSortie : une pompe retardataire du cas
    # précédent ne doit pas désarmer la détection ici).
    global ETAT_SORTIE
    ETAT_SORTIE = EtatSortie(case["index"])
    case_dir = os.path.join(BOX, "cases", str(case["index"]))
    runner = RUNNERS[language]
    env = base_env(case_dir)
    os.makedirs(env["HOME"], exist_ok=True)
    os.makedirs(env["TMPDIR"], exist_ok=True)
    start = time.monotonic()
    outcome, compile_error = runner(case_dir, env, timeout_s, case["index"])
    elapsed_ms = int((time.monotonic() - start) * 1000)
    if compile_error is not None:
        outcome = CaseOutcome(False, compile_error, ran=False)
    if ETAT_SORTIE.tue_par_signal and not outcome.passed:
        outcome.killed = True
    if ETAT_SORTIE.expire and not outcome.passed:
        # Vaut aussi pour une COMPILATION expirée, que les runners rapportent en simple
        # « Échec de compilation » : c'est une cause NON CONCLUANTE, pas un sabotage.
        outcome.timed_out = True
    if ETAT_SORTIE.perdue and not outcome.passed:
        # Saturation du tmpfs : NON IMPUTABLE, exactement comme une erreur interne. Sans ce
        # marquage, un canari tombé sur une saturation échouait, et canary_verdict concluait
        # « incoherents » → bandeau « falsification probable » et mise à zéro de TOUTE la
        # soumission, pour un disque plein. Ne pas accuser le noteur ni l'étudiant.
        #
        # SEULEMENT sur un cas en ÉCHEC : « perdue » est posé dès qu'un des deux flux (ou la
        # fermeture d'un des deux fichiers) échoue, or le verdict a pu conclure « réussi » sur
        # un stdout intact — la ligne du jeton ET le code de sortie étaient alors bien là. Un
        # cas vert n'a rien à protéger, et il recevait un détail qui le contredisait.
        outcome.skipped = True
        # Et DIRE la cause : le détail serait resté « Échec du harnais JUnit » (ou l'équivalent
        # du langage), envoyant l'étudiant chercher un bug de logique inexistant. Les deux
        # autres chemins de la même condition sont explicites, celui-ci doit l'être aussi.
        outcome.detail = ("Espace de travail saturé : le code écrit trop de fichiers ou trop "
                          "de sorties — notation impossible")
    return outcome, elapsed_ms


# ────────────────────────── mode « exec » (ex-Piston) ──────────────────────────
# Exécution générique d'un programme assemblé par execution-service : les interprétés/SQL/vues
# (programmes RPC 2-processus à nonce, inchangés) et le bouton « Exécuter » de tous les langages.
# TOUT tourne sous l'UID étudiant, compilation comprise (le job entier est non fiable, comme dans
# Piston : le noteur assemblé embarque sa propre protection). Sémantique de sortie à la Piston :
# étapes {stdout, stderr, code, signal} — signal = "SIGKILL" en cas de temps dépassé.

EXEC_OUTPUT_CAP = 1_200_000     # ≥ 1 Mio : le dump SQL de la phase 1 peut approcher 512 Ki
EXEC_COMPILE_TIMEOUT_S = 60
EXEC_DEFAULT_TIMEOUT_S = 3


def exec_commands(runtime, entry):
    """(commande de compilation ou None, commande d'exécution) pour un runtime donné."""
    quoted = "'" + entry.replace("'", "'\\''") + "'"
    if runtime == "python":
        return None, ["python3", entry]
    if runtime == "javascript":
        return None, ["node", entry]
    if runtime == "typescript":
        # Transpile tous les .ts côte à côte (le grader spawn `node student_server` → .js résolu).
        # --noCheck : transpilation seule, typage permissif à l'exécution (parité avec l'ancien
        # runtime Piston ; les erreurs de SYNTAXE restent des erreurs de compilation).
        return (["sh", "-c", "tsc --noCheck --target es2020 --module commonjs --esModuleInterop "
                             "--skipLibCheck *.ts"],
                ["node", entry[:-3] + ".js" if entry.endswith(".ts") else entry])
    if runtime == "php":
        return None, ["php", entry]
    if runtime == "bash":
        return None, ["bash", entry]
    if runtime == "sqlite3":
        # -bail : une erreur SQL arrête le script avec un exit non nul (verdict « erreur SQL »).
        return None, ["sh", "-c", "exec sqlite3 -bail -batch :memory: < " + quoted]
    if runtime == "c":
        return ["gcc", "-O2", entry, "-o", "prog", "-lm"], ["./prog"]
    if runtime == "c++":
        return ["g++", "-std=c++20", "-O2", entry, "-o", "prog"], ["./prog"]
    if runtime == "java":
        return None, ["java", entry]  # mode fichier-source (JEP 330)
    if runtime == "csharp":
        return ["mcs", entry, "-out:prog.exe"], ["mono", "prog.exe"]
    if runtime == "go":
        # Compilation SÉPARÉE (budget EXEC_COMPILE_TIMEOUT_S) : `go run` compilait dans la
        # fenêtre de run (défaut 3 s) — un « Exécuter » correct pouvait être « Interrompu ».
        return ["go", "build", "-o", "prog", entry], ["./prog"]
    if runtime == "rust":
        return ["rustc", "-O", entry, "-o", "prog"], ["./prog"]
    return None, None


def exec_stage(code, timed_out, out_path, err_path):
    # Processus tué par un signal (OOM du cgroup, limite mémoire…) : returncode négatif →
    # rapporté comme SIGNAL, à la Piston (code null + signal), comme un temps dépassé.
    signal_name = None
    if timed_out:
        signal_name = "SIGKILL"
    elif code is not None and code < 0:
        try:
            signal_name = signal.Signals(-code).name
        except ValueError:
            signal_name = "SIG" + str(-code)
        code = None
    return {"stdout": read_capped(out_path, EXEC_OUTPUT_CAP),
            "stderr": read_capped(err_path, EXEC_OUTPUT_CAP),
            "code": code, "signal": signal_name}


def exec_env(work):
    env = dict(base_env(BOX))
    env["HOME"] = os.path.join(work, "home")
    env["TMPDIR"] = os.path.join(work, "tmp")
    env["GOCACHE"] = os.path.join(work, "gocache")
    env["GOPATH"] = os.path.join(work, "gopath")
    env["CARGO_TARGET_DIR"] = os.path.join(work, "target")
    return env


def exec_main(job):
    src = os.path.join(BOX, "src")
    work = os.path.join(BOX, "work")
    for name in ("home", "tmp"):
        os.makedirs(os.path.join(work, name), exist_ok=True)
    # Tout le job est non fiable : sources possédées par l'étudiant (le grader s'auto-supprime).
    for root, dirs, files in os.walk(BOX):
        for name in dirs + files:
            os.chown(os.path.join(root, name), STUDENT_UID, STUDENT_GID)
    os.chown(BOX, STUDENT_UID, STUDENT_GID)

    runtime = job.get("runtime", "")
    entry = job.get("entry", "")
    compile_cmd, run_cmd = exec_commands(runtime, entry)
    if run_cmd is None:
        print(json.dumps({"v": 1, "error": "runtime non pris en charge : " + runtime}))
        return
    env = exec_env(work)

    stdin_path = None
    if job.get("stdin"):
        stdin_path = os.path.join(BOX, "stdin.txt")
        with open(stdin_path, "w", encoding="utf-8") as f:
            f.write(job["stdin"])
        os.chown(stdin_path, STUDENT_UID, STUDENT_GID)

    compile_stage = None
    if compile_cmd is not None:
        code, timed_out = run_proc(compile_cmd, src, env, EXEC_COMPILE_TIMEOUT_S,
                                   os.path.join(work, "cc.out"), os.path.join(work, "cc.err"),
                                   demote_student)
        compile_stage = exec_stage(code, timed_out, os.path.join(work, "cc.out"),
                                   os.path.join(work, "cc.err"))
        if timed_out or code != 0:
            print(json.dumps({"v": 1, "compile": compile_stage, "run": None}, ensure_ascii=False))
            return

    timeout_s = max(1, min(MAX_RUN_TIMEOUT_S,
                           int(job.get("timeout_ms") or EXEC_DEFAULT_TIMEOUT_S * 1000) // 1000))
    if runtime == "java":
        # Mode fichier-source (JEP 330) : la COMPILATION vit dans la fenêtre de run, et la JVM
        # froide y ajoute 1 à 2 s — avec le défaut de 3 s, un « Exécuter » correct pouvait être
        # « Interrompu » par intermittence. Plancher dédié.
        timeout_s = max(timeout_s, 10)
    code, timed_out = run_proc(run_cmd, src, env, timeout_s,
                               os.path.join(work, "run.out"), os.path.join(work, "run.err"),
                               demote_student, stdin_path=stdin_path)
    run_stage = exec_stage(code, timed_out, os.path.join(work, "run.out"),
                           os.path.join(work, "run.err"))
    print(json.dumps({"v": 1, "compile": compile_stage, "run": run_stage}, ensure_ascii=False))


STAGING = "/opt/moodit/staging"


def wait_for_files():
    """Le job est copié par docker cp AVANT le démarrage dans STAGING (couche image : docker cp
    ne sait pas écrire dans un tmpfs). On attend la sentinelle .ready (dernière entrée du tar)
    puis on DÉPLACE le job dans le tmpfs /box — seul point d'écriture du code étudiant."""
    deadline = time.monotonic() + READY_WAIT_S
    ready = os.path.join(STAGING, ".ready")
    while not os.path.exists(ready):
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)
    os.makedirs(BOX, exist_ok=True)
    for name in os.listdir(STAGING):
        if name != ".ready":
            shutil.move(os.path.join(STAGING, name), os.path.join(BOX, name))
    shutil.rmtree(STAGING, ignore_errors=True)
    return True


def main():
    # AVANT tout chown/setuid : l'UID étudiant de ce conteneur est tiré au sort.
    randomize_student_uid()
    if not wait_for_files():
        print(json.dumps({"v": 1, "error": "fichiers du job non reçus"}))
        return
    with open(os.path.join(BOX, "job.json"), "r", encoding="utf-8") as f:
        job = json.load(f)
    if job.get("mode") == "exec":
        exec_main(job)
        return
    language = job["language"]
    if language not in RUNNERS:
        print(json.dumps({"v": 1, "error": "langage non pris en charge : " + language}))
        return
    timeout_s = max(1, min(MAX_RUN_TIMEOUT_S,
                           int(job.get("timeout_ms") or DEFAULT_RUN_TIMEOUT_S * 1000) // 1000))
    if language in ("java", "csharp"):
        # Plancher VM, symétrique du mode exec : JVM + ConsoleLauncher (ou mono + NUnitLite)
        # mettent couramment 2 à 5 s à démarrer — un temps limite court mais légitime du prof
        # (1-5 s) tuait sinon TOUS les cas, canaris compris → « falsification probable » à tort.
        timeout_s = max(timeout_s, 10)

    cases = job["cases"]
    # Canaris et JETONS : valeurs tirées MAINTENANT (imprévisibles), ordre d'exécution mélangé.
    # Le jeton de fin d'exécution (un par cas, gabarit __MOODIT_T__) est imprimé par le POINT DE
    # SORTIE du framework, après tous les tests : un code étudiant qui forge un rapport puis
    # exit(0) depuis la FONCTION NOTÉE saute cette impression → verdict échoué (jeton_absent).
    # L'obtenir exige de lire la source verrouillée (EACCES + tracé) ou son propre binaire
    # (tracé aussi, lecture_binaire_tentee) — l'attaque redevient bruyante.
    rng = random.SystemRandom()
    for case in cases:
        case_dir = os.path.join(BOX, "cases", str(case["index"]))
        TOKENS[case["index"]] = str(rng.randrange(10**12, 10**13))
        STUDENT_TYPES[case["index"]] = case.get("student_types") or []
        HARNESS_TYPES[case["index"]] = case.get("harness_types") or []
        subst = {"__MOODIT_T__": TOKENS[case["index"]]}
        if case.get("canary"):
            # Nom du test canari randomisé (identifiant valide, majuscule en tête pour
            # l'export Go) : un nom FIXE serait reconnaissable par le code étudiant.
            subst["__MOODIT_N__"] = random_identifier(rng)
            CANARY_NAMES[case["index"]] = subst["__MOODIT_N__"]
        if case.get("canary") == "pass":
            a = rng.randrange(100000, 999999)
            subst.update({"__MOODIT_A__": str(a), "__MOODIT_B__": str(a)})
        elif case.get("canary") == "fail":
            a = rng.randrange(100000, 999999)
            subst.update({"__MOODIT_A__": str(a),
                          "__MOODIT_B__": str(a + 1 + rng.randrange(1000))})
        substitute_placeholders(case_dir, subst)
    order = list(cases)
    rng.shuffle(order)

    outcomes = {}
    timings = {}
    # Budget GLOBAL du job (ms), transmis par execution-service : son mur de conteneur moins
    # une marge. Au-delà, le superviseur CLÔT proprement et renvoie les verdicts obtenus — les
    # cas non exécutés comptent échoués avec un détail explicite. Sans lui, le démon tuait le
    # conteneur au mur et TOUT le travail était perdu : 502 → la tentative de l'étudiant était
    # supprimée (sans rejouage), de façon reproductible sur une question à beaucoup de cas.
    budget_ms = job.get("budget_ms")
    deadline = (time.monotonic() + budget_ms / 1000.0) if budget_ms else None
    # Les CANARIS gardent leur part du budget : sans réserve, un code dont chaque cas coûte
    # cher pouvait faire sauter la fin de la file — canaris compris — et neutraliser ainsi le
    # contrôle anti-falsification (le cas sauté ne pouvant, à juste titre, accuser personne).
    # Un dépassement saute donc des cas RÉELS en premier. L'ordre reste tiré au sort : exécuter
    # les canaris d'abord les rendrait reconnaissables.
    canary_reserve_s = 0.0
    if deadline is not None and budget_ms:
        canary_reserve_s = canary_reserve_seconds(budget_ms / 1000.0, timeout_s)

    for case in order:
        if box_exhausted():
            # Espace de travail saturé (par un cas précédent, ou par la copie du job) : rien
            # à reprocher à l'étudiant, et surtout pas une falsification — un cas « sauté »
            # n'entre pas dans le verdict des canaris.
            outcomes[case["index"]] = CaseOutcome(
                False, "Espace de travail saturé : le code écrit trop de fichiers "
                       "(ou des fichiers trop gros) dans son dossier temporaire.",
                ran=False, skipped=True)
            timings[case["index"]] = 0
            event("espace_sature", case=case["index"])
            continue
        # Un cas réel doit laisser la réserve des canaris intacte ; un canari puise dedans.
        case_deadline = deadline
        if deadline is not None and not case.get("canary"):
            case_deadline = deadline - canary_reserve_s
        if case_deadline is not None and time.monotonic() >= case_deadline:
            outcomes[case["index"]] = CaseOutcome(
                False, "Non exécuté : budget de notation dépassé (trop de cas ou cas trop longs)",
                ran=False, skipped=True)
            timings[case["index"]] = 0
            event("budget_depasse", case=case["index"])
            continue
        try:
            outcome, ms = execute_case(language, case, timeout_s)
        except Exception as e:  # défaut du superviseur : fail-closed, jamais de faux « réussi »
            log("superviseur: exception sur le cas %s : %r" % (case["index"], e))
            # skipped=True : NON IMPUTABLE. Le cas échoue (fail-closed), mais un canari tombé
            # sur une erreur interne — un /box saturé, par exemple — passait sinon par la porte
            # « incoherents » de canary_verdict, donc par « falsification probable » et la mise
            # à zéro de toute la soumission. Une défaillance du noteur ne doit jamais accuser.
            outcome, ms = CaseOutcome(False, "Erreur interne du noteur",
                                      ran=False, skipped=True), 0
            event("erreur_superviseur", case=case["index"], detail=repr(e))
        outcomes[case["index"]] = outcome
        timings[case["index"]] = ms
        # Isolation inter-cas : un processus étudiant qui a fait fork + setsid a quitté le
        # groupe tué au timeout — il survivrait au cas et pourrait peser sur (voire tracer,
        # même UID) les cas suivants. Balayage de TOUT processus UID étudiant entre deux cas.
        kill_student_survivors()
        # Le tmpfs /box est compté dans la MÉMOIRE du conteneur : les artefacts de build du cas
        # (target cargo ~50-100 Mo, HOME/TMP de compilation) ne servent plus après son verdict —
        # les accumuler faisait saturer une question Rust à beaucoup de cas (ENOSPC déguisé en
        # « Échec de compilation », voire OOM). Le gocache partagé, lui, sert aux cas suivants.
        # Le cas est noté : TOUT son répertoire est libéré, work/ compris (HOME et TMPDIR de
        # l'étudiant — ses seuls points d'écriture). Ne libérer que les caches de build laissait
        # un code qui écrit des fichiers saturer le tmpfs /box, partagé par tous les cas : les
        # suivants ne compilaient plus, canaris inclus, et la soumission — honnête mais boguée —
        # était étiquetée « falsification probable ». Le gocache partagé (hors cases/) survit.
        shutil.rmtree(os.path.join(BOX, "cases", str(case["index"])), ignore_errors=True)

    # Verdict des canaris : significatif seulement si leurs runs ont eu lieu (sinon l'échec de
    # compilation du code étudiant les explique déjà, et les vrais cas échouent de toute façon).
    canaries = canary_verdict(cases, outcomes)

    results = []
    for case in cases:
        if case.get("canary"):
            continue
        outcome = outcomes[case["index"]]
        passed, detail = outcome.passed, outcome.detail
        if canaries == "incoherents":
            passed = False
            detail = ("⚠ Incohérence détectée pendant la notation (falsification probable). "
                      + (detail or ""))
        results.append({"index": case["index"], "name": case.get("name", ""),
                        "passed": bool(passed),
                        "detail": redact_tokens(detail),
                        "ms": timings[case["index"]]})

    print(json.dumps({"v": 1, "results": results, "events": EVENTS, "canaries": canaries},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
