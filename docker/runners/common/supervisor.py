#!/usr/bin/env python3
"""Superviseur de notation MoodIT (#116) — processus de CONFIANCE du conteneur runner.

Tourne en root dans un conteneur jetable (réseau coupé, /box et /tmp en tmpfs bornés — seuls
points d'écriture de l'UID étudiant, les images verrouillant leurs répertoires monde-inscriptibles).
Le code étudiant, lui, ne tourne JAMAIS en root : chaque cas est exécuté sous l'UID `student`,
sans toolchain (binaires de test autonomes), sources verrouillées en 700 root.

Modèle de confiance :
  - INTÉGRITÉ  : un cas est RÉUSSI si, et seulement si, le NONCE du cas paraît sur le stderr du
    NOTEUR — un programme séparé, sous un UID séparé, dans lequel aucun code soumis ne tourne.
    Tout le reste vaut échec (fail-closed). Deux CANARIS par soumission (un qui doit réussir, un
    qui doit échouer, valeurs tirées au sort à l'exécution, position mélangée) vérifient que la
    chaîne tranche encore dans les deux sens.
  - CONFIDENTIALITÉ : le harnais et le nonce ne sont PAS dans le processus du code soumis. Les
    sources appartiennent de plus à root en 700 dès leur extraction, et le processus étudiant
    reçoit EACCES s'il tente de les lire.
  - DÉTECTION  : il n'y en a pas, et c'est le propos. Le harnais et le nonce n'entrent dans
    aucun processus ni fichier que le code soumis puisse atteindre : il n'y a rien à
    surveiller. Les événements restants portent sur l'INFRASTRUCTURE (budget_depasse,
    espace_sature, erreur_superviseur) et sur les canaris.

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

import bisect
import collections
import functools
import glob
import json
import os
import random
import re
# `resource` est POSIX : absent sous Windows, l environnement de dev du projet. Les
# fonctions qui posent des rlimits ne tournent que DANS le conteneur (Linux) ; proteger
# l import permet de rejouer les 93 tests unitaires du superviseur en local, sans Docker.
try:
    import resource
except ImportError:  # Windows : les preexec_fn ne sont jamais appeles hors conteneur
    resource = None
import shutil
import signal
import stat
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

class ExitState:
    """Capture des sorties d'UN cas : des octets ont-ils été perdus (tmpfs saturé) ?

    La queue est alors perdue, donc la ligne du jeton aussi. Sans cet état, Java et C#
    tiraient leur « looked_ok » du XML sous work/ (déjà écrit) et concluaient « jeton
    absent », c'est-à-dire une accusation de forgeage pour une saturation.

    C'est un OBJET remplacé à chaque cas, et non un drapeau global : les pompes de sortie
    peuvent SURVIVRE à leur run_proc, et un global aurait été repositionné par une pompe
    retardataire pendant le cas SUIVANT — désarmant la détection de forgeage sur un cas où
    rien n'avait saturé. Une pompe retardataire n'écrit que dans l'état de SON cas."""

    def __init__(self, case_index=None):
        self.lost = False
        self.case = case_index
        # Un processus du cas est mort PAR SIGNAL (OOM du cgroup, SIGSEGV…). Posé ici plutôt
        # que dans chacun des six runners : run_proc est le seul endroit qui voie le code brut.
        self.killed_by_signal = False
        # Un processus du cas a dépassé son temps limite. Les runners écrasent l'information
        # (« if timed_out or code != 0: Échec de compilation »), si bien qu'une COMPILATION
        # expirée arrivait avec timed_out=False et passait pour une cause concluante : un code
        # lent à compiler se faisait accuser de sabotage.
        self.expired = False


EXIT_STATE = ExitState()

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


# Ouverture par root SANS suivre de lien et sans bloquer sur une FIFO. Drapeaux POSIX lus par
# getattr : le superviseur ne tourne que sous Linux, mais ses tests unitaires tournent aussi
# sous Windows (O_BINARY : pas de traduction des fins de ligne).
O_NO_LINK = (getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
               | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0))


def read_capped(path, cap=OUTPUT_CAP):
    """Relit une sortie capturée en bornant la mémoire : TÊTE + QUEUE du fichier quand il
    dépasse le plafond. La queue est indispensable aux canaux de VERDICT — jeton de fin,
    sommaire du framework, verdict encadré par nonce du mode exec — tous imprimés en fin de
    sortie : tronquer seulement la tête transformait une copie honnête mais bavarde
    (> 64 Kio de print de débogage) en « jeton absent », fausse accusation de triche."""
    try:
        # Sans suivre de lien et sans bloquer : root relit des fichiers poses dans des dossiers
        # que le code soumis peut atteindre. Un lien lui faisait relire un fichier root du
        # conteneur, une FIFO le bloquait jusqu'au mur. Seul un fichier ORDINAIRE est relu.
        fd = os.open(path, os.O_RDONLY | O_NO_LINK)
        with os.fdopen(fd, "rb") as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode):
                return ""
            size = st.st_size
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

    Le nom (`student`) ne change pas : les Dockerfiles restent valides.
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


def pending_canary_reserve(reserve_s, total_canaries, pending_canaries):
    """Part de la réserve encore due aux canaris NON EXÉCUTÉS — FONCTION PURE (testée).

    La réserve est rendue au fur et à mesure : sans cela, une fois les deux canaris passés, les
    cas réels restants perdaient encore le tiers du budget et étaient sautés alors qu'il
    restait du temps — une note partielle sur le « Tester » du prof."""
    if total_canaries <= 0 or pending_canaries <= 0:
        return 0.0
    return reserve_s * min(pending_canaries, total_canaries) / total_canaries


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
    judgeable = [c for c in canary_cases if not outcomes[c["index"]].skipped]
    not_imputable = len(judgeable) < len(canary_cases)
    if not judgeable:
        return "indetermines"
    real_cases = [c for c in cases if not c.get("canary") and not outcomes[c["index"]].skipped]

    confirmed, accusable = [], []
    for c in judgeable:
        issue = outcomes[c["index"]]
        if issue.ran and issue.passed == (c["canary"] == "pass"):
            confirmed.append(c)                       # CONFIRMÉ
        elif issue.ran or not inconclusive(issue):
            accusable.append(c)                      # non confirmé, et imputable a priori
        # sinon : compilation échouée pour une cause non concluante — règle 2, jamais d'accusation

    if accusable:
        # LE critère : l'étudiant y gagne-t-il ? Sans cas réel vert, faire échouer des canaris
        # ne rapporte rien — accuser ne protégerait donc personne et frapperait un code
        # honnête. C'est aussi ce qui couvre l'échec de compilation global (aucun cas vert).
        if any(outcomes[c["index"]].passed for c in real_cases):
            event("canari_incoherent",
                  detail="canaris non conformes alors qu'un cas réel a réussi "
                         "— falsification probable")
            return "incoherents"
        return "indetermines"
    # « ok » exige que CHAQUE canari ait été CONFIRMÉ : un canari non compilé pour une cause
    # non concluante n'accuse pas, mais il n'a rien vérifié non plus — répondre « ok »
    # prétendrait le contraire. Idem si l'un était non imputable.
    if not_imputable or len(confirmed) != len(judgeable):
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


def real_uid(status):
    """UID reel lu dans un /proc/<pid>/status, ou None. PURE (testee)."""
    for line in status.splitlines():
        if line.startswith("Uid:"):
            parts = line.split()
            return parts[1] if len(parts) > 1 else None
    return None


def task_state(stat_line):
    """Etat d'une tache lu dans /proc/<pid>/task/<tid>/stat. PURE (testee). Le nom du programme,
    entre parentheses, peut contenir espaces et parentheses : on lit apres la DERNIERE."""
    rest = stat_line[stat_line.rfind(")") + 1:].split()
    return rest[0] if rest else "X"


def tasks_alive(states):
    """Un processus est-il encore VIVANT ? PURE (testee).

    Juger sur l'etat du seul processus ne suffit pas : un programme multithread dont le fil
    PRINCIPAL est sorti est affiche Z (zombie) alors que ses autres fils tournent encore. On
    regarde donc chaque tache : vivant tant qu'une n'est ni Z ni X."""
    return any(e not in ("Z", "X") for e in states)


def kill_student_uid():
    """SIGKILL a TOUS les processus de l'UID etudiant, en un appel : kill(-1) lance SOUS cet
    UID atteint tout ce qu'il peut signaler, quel que soit l'etat, le groupe ou la session
    (setsid ne protege de rien), et le noyau le fait sans laisser de fork s'intercaler."""
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(STUDENT_GID)
            os.setuid(STUDENT_UID)
            os.kill(-1, signal.SIGKILL)
        except BaseException:
            pass
        finally:
            os._exit(0)
    os.waitpid(pid, 0)


def _survivor_pass():
    """Compte les processus de l'UID etudiant encore vivants ; recolte les zombies VRAIMENT
    morts. Le superviseur est PID 1 : les orphelins lui reviennent, et sans recolte ils
    occupaient pour toujours une entree de la table des processus (512 par conteneur)."""
    alive = 0
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/" + pid + "/status", "r") as f:
                if real_uid(f.read()) != str(STUDENT_UID):
                    continue
            states = []
            for tid in os.listdir("/proc/" + pid + "/task"):
                with open("/proc/" + pid + "/task/" + tid + "/stat", "r") as f:
                    states.append(task_state(f.read()))
        except (OSError, ValueError):
            continue
        if tasks_alive(states):
            alive += 1
            continue
        try:
            # Recolte CIBLEE (ce pid, jamais -1) : un waitpid(-1) volerait le statut des
            # sous-processus du superviseur lui-meme (compilations, noteurs).
            os.waitpid(int(pid), os.WNOHANG)
        except ChildProcessError:
            pass
    return alive


def kill_student_survivors():
    """Isolation entre les cas d'une meme evaluation : plus AUCUN processus de l'UID etudiant
    ne survit au cas qui l'a lance. Appele entre deux cas.

    On tue par l'UID (kill_student_uid), puis on verifie : la mort d'un processus tue n'est
    pas instantanee. Borne a 25 passes pour ne jamais rester coince ici."""
    for _ in range(25):
        kill_student_uid()
        if _survivor_pass() == 0:
            return
        time.sleep(0.05)


GO_STUDENT_DIRS = ("gocache_etu", "gopath_etu")


def reset_go_student_dirs(keep_cache=False):
    """(Re)crée VIDES les dossiers de build Go de l'étudiant, sauf le cache si keep_cache.

    Ils appartiennent à l'UID étudiant (son compilateur y écrit) : un lien qu'il y aurait posé
    est retiré sans être suivi (unlink ; rmtree ne suit pas les liens)."""
    for name in GO_STUDENT_DIRS:
        fpath = os.path.join(BOX, name)
        if (keep_cache and name == "gocache_etu" and os.path.isdir(fpath)
                and not os.path.islink(fpath)):
            continue
        if os.path.islink(fpath) or os.path.isfile(fpath):
            os.unlink(fpath)
        else:
            shutil.rmtree(fpath, ignore_errors=True)
        os.makedirs(fpath, exist_ok=True)
        os.chown(fpath, STUDENT_UID, STUDENT_GID)
        os.chmod(fpath, 0o700)


def purge_shared_dirs():
    """Vide /tmp et /dev/shm entre deux cas : ces tmpfs survivent d'un cas a l'autre, et un
    fichier depose au cas N (un nonce exfiltre, un relais) etait lisible au cas N+1."""
    for directory in ("/tmp", "/dev/shm"):
        try:
            for ident in os.listdir(directory):
                fpath = os.path.join(directory, ident)
                try:
                    if os.path.isdir(fpath) and not os.path.islink(fpath):
                        shutil.rmtree(fpath, ignore_errors=True)
                    else:
                        os.unlink(fpath)
                except OSError:
                    continue
        except OSError:
            continue



def preexec_student_compile():
    """Compilation du CODE SOUMIS : sous l'UID ETUDIANT, jamais root.

    Le compilateur obeit a un texte choisi par l'etudiant — include_str! (Rust), .incbin via
    asm (C/C++), preambule cgo (Go) — et peut donc EMBARQUER dans le binaire tout fichier
    lisible par son processus. Compile par root, « tout fichier » incluait le noteur, nonce
    compris, deja sur disque a cote. Sous l'UID etudiant, ces inclusions recoivent EACCES
    comme n'importe quelle autre lecture : la garantie ne depend plus d'une liste d'idiomes
    d'inclusion a connaitre, mais des droits."""
    os.setsid()
    os.setgroups([])
    os.setgid(STUDENT_GID)
    os.setuid(STUDENT_UID)


def student_build_env(build_dir):
    """Environnement de la compilation ETUDIANTE : tout ce qui s'ecrit lui appartient.

    CGO_ENABLED=0 est pose ICI et dans base_env : l'ENV du Dockerfile go ne survit pas au
    env= de Popen, qui REMPLACE l'environnement — la parade de l'image etait perdue en
    silence."""
    return {
        "PATH": os.environ.get("PATH",
                               "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
        "HOME": os.path.join(build_dir, "home"),
        "LANG": "C.UTF-8",
        "TMPDIR": os.path.join(build_dir, "tmp"),
        "GOCACHE": os.path.join(BOX, "gocache_etu"),
        "GOPATH": os.path.join(BOX, "gopath_etu"),
        "GOFLAGS": "-mod=mod",
        "CGO_ENABLED": "0",
        "RUSTUP_HOME": "/usr/local/rustup",
    }


def set_owner_mode(fpath, uid, gid, mode, dir_mode=None):
    """chown + chmod par DESCRIPTEUR, ouvert sans suivre de lien et sans bloquer.

    root pose ces droits dans des dossiers que le code soumis a pu toucher : par chemin, un
    lien pose a la place d'un fichier lui faisait changer la CIBLE. Ici un lien echoue (ELOOP,
    une OSError : panne d'environnement imputable, donc une note), et ce qui est change est
    exactement ce qui a ete ouvert. `mode_dossier` s'applique si c'est un dossier."""
    fd = os.open(fpath, os.O_RDONLY | O_NO_LINK)
    try:
        st = os.fstat(fd)
        os.fchown(fd, uid, gid)
        os.fchmod(fd, dir_mode if (dir_mode is not None
                                       and stat.S_ISDIR(st.st_mode)) else mode)
    finally:
        os.close(fd)


def set_owner_mode_tree(tree_root, uid, gid, file_mode, dir_mode):
    """set_owner_mode sur un arbre, racine comprise. Un lien n'est ni suivi ni modifie."""
    if os.path.islink(tree_root):
        return
    for r, ds, fs in os.walk(tree_root):
        for ident in ds + fs:
            fpath = os.path.join(r, ident)
            if not os.path.islink(fpath):
                set_owner_mode(fpath, uid, gid, file_mode, dir_mode)
    set_owner_mode(tree_root, uid, gid, dir_mode, dir_mode)


def chown_tree(tree_root, uid, gid):
    """chown recursif, racine comprise — sans suivre aucun lien (cf. lock_sources)."""
    if os.path.islink(tree_root):
        return
    for r, ds, fs in os.walk(tree_root):
        for ident in ds + fs:
            os.chown(os.path.join(r, ident), uid, gid, follow_symlinks=False)
    os.chown(tree_root, uid, gid)


def student_build_dir(case_dir):
    """Chantier de compilation ETUDIANT : ne contient que son code, et lui appartient."""
    d = os.path.join(case_dir, "etu_build")
    os.makedirs(os.path.join(d, "home"), exist_ok=True)
    os.makedirs(os.path.join(d, "tmp"), exist_ok=True)
    chown_tree(d, STUDENT_UID, STUDENT_GID)
    os.chmod(d, 0o700)
    return d


def write_private(fpath, src_text):
    """Fichier SECRET (noteur : harnais + nonce) en 0600 root DES SA CREATION.

    Ouvert puis ecrit en 0644 par defaut, il restait lisible de tous pendant toute la fenetre
    des compilations — le chmod d'apres-coup fermait la porte apres le passage."""
    fd = os.open(fpath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(src_text)


def lock_src_dir(case_dir):
    """Bloque la TRAVERSEE de src/ (harnais marque compris) avant toute compilation etudiante.
    root, lui, lit a travers ; le processus etudiant recoit EACCES."""
    src = os.path.join(case_dir, "src")
    if os.path.isdir(src):
        os.chown(src, 0, 0)
        os.chmod(src, 0o700)


def preexec_compile():
    """preexec_fn des compilations du mode evaluate (root) : groupe de processus dédié —
    sans setsid, killpg au timeout échouait (le compilateur partage le pgid du superviseur)
    et proc.wait() bloquait jusqu'au budget mural du conteneur (502 au lieu d'un verdict
    « Échec de compilation »). Pas de rlimits : un binaire de test (debug) peut dépasser
    la borne FSIZE des processus étudiants.

    umask 077 : le compilateur cree le binaire du NOTEUR (harnais et nonce) ; avec l'umask par
    defaut, il naissait en 0755 et restait lisible de tous jusqu'au chmod 0500."""
    os.setsid()
    os.umask(0o077)


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
               state=None):
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
    head_open = True
    try:
        while True:
            chunk = src.read(65536)
            if not chunk:
                break
            if writable and head_open:
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
                    head_open = False
                    cut_at = part.rfind(b"\n")
                    part = part[: cut_at + 1] if cut_at >= 0 else b""
                try:
                    dst.write(part)
                    written += len(part)
                except (OSError, ValueError):
                    writable = False      # tmpfs saturé / fichier refermé : on continue à LIRE
                    part = b""
                    if state is not None:
                        state.lost = True
                chunk = chunk[len(part):]
            if chunk:
                dropped += len(chunk)
                tail.extend(chunk)
        if writable and dropped:
            kept = bytes(tail)
            dropped -= len(kept)
            # MÊME libellé que read_capped, au mot près : libtest_selection s'en sert pour
            # détecter une sortie tronquée et renoncer alors au filtre.
            marker = ("\n… (sortie tronquée au milieu : %d octets)\n"
                        % (written + dropped + len(kept))).encode("utf-8")
            try:
                dst.write(marker)
                dst.write(kept)
            except (OSError, ValueError):
                if state is not None:
                    state.lost = True
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
    state = EXIT_STATE          # état DU CAS en cours, capturé une fois pour toutes
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
                                        PUMP_TAIL_BYTES, state), daemon=True),
                 threading.Thread(target=drain_pipe,
                                  args=(proc.stderr, err, OUTPUT_FILE_CAP,
                                        PUMP_TAIL_BYTES, state), daemon=True)]
        for pump in pumps:
            pump.start()
        try:
            code, timed_out = proc.wait(timeout=timeout_s), False
            if code is not None and code < 0:
                state.killed_by_signal = True      # subprocess rend -N pour un signal
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                # Pas de groupe dédié (preexec sans setsid) : au moins tuer le processus
                # lui-même, sinon proc.wait() bloque pour toujours et tout le job meurt en 502.
                proc.kill()
            proc.wait()
            code, timed_out = None, True
            state.expired = True
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
        purge_shared_dirs()
        due = time.monotonic() + PUMP_SWEEP_JOIN_S
        for pump in pumps:
            pump.join(timeout=max(0, due - time.monotonic()))
        if any(pump.is_alive() for pump in pumps):
            # Dernier recours : un survivant que ni le groupe ni l'UID étudiant n'ont attrapé.
            # Échéance BORNÉE — un fil encore vivant au fork du Popen suivant est un risque
            # (preexec_fn n'est pas sûr depuis un processus multithreadé), mais pendre ici
            # ferait tuer le conteneur au mur et perdrait TOUTE la notation.
            due = time.monotonic() + PUMP_JOIN_S
            for pump in pumps:
                pump.join(timeout=max(0, due - time.monotonic()))
        for pump, stream in zip(pumps, (proc.stdout, proc.stderr)):
            # Fermer un tube dont la pompe est ENCORE VIVANTE bloquerait : elle attend dans
            # read() en tenant le verrou du tampon, et close() doit l'acquérir — sans borne, ce
            # qui annulerait le join borné ci-dessus et ferait tuer le conteneur au mur (toute
            # la notation perdue). Le superviseur est éphémère : un descripteur laissé ouvert
            # disparaît avec lui.
            if not pump.is_alive():
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass
        return code, timed_out
    except OSError as e:
        # Un /box saturé fait échouer jusqu'à l'OUVERTURE des fichiers de sortie (ENOSPC sur
        # O_CREAT), et Popen peut lever (fork ENOMEM). Laisser remonter aurait rendu le cas
        # « Erreur interne du noteur » — accusation sur une saturation. On dégrade : pas de
        # sortie, donc pas de verdict « réussi » possible, mais rien d'imputable.
        state.lost = True
        event("espace_sature", case=state.case,
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
        saturated = False
        for stream in (out, err):
            if stream is None:
                continue
            try:
                stream.close()
            except OSError:
                saturated = True      # une saturation est UNE condition, pas une par flux
        if saturated:
            state.lost = True
            event("espace_sature", case=state.case,
                  detail="écriture des sorties impossible")


def student_dir(case_dir, name):
    """Crée un dossier possédé par l'étudiant (sorties, HOME, TMP)."""
    path = os.path.join(case_dir, name)
    os.makedirs(path, exist_ok=True)
    os.chown(path, STUDENT_UID, STUDENT_GID)
    os.chmod(path, 0o700)
    return path


def grader_dir(case_dir, name):
    """Dossier privé du NOTEUR (HOME, TMP) : 700 à son UID, sous case_dir (root, 755).

    Jamais sous work/ : ce dossier appartient à l'étudiant, qui pouvait y renommer le dossier
    du noteur pendant l'exécution et poser le sien à la place."""
    path = os.path.join(case_dir, name)
    os.makedirs(path, exist_ok=True)
    os.chown(path, grader_uid(), grader_uid())
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
        "CGO_ENABLED": "0",
        "CARGO_TARGET_DIR": os.path.join(case_dir, "target"),
        "MONO_PATH": "/opt/moodit",
        "RUSTUP_HOME": "/usr/local/rustup",
        "TMPDIR": os.path.join(case_dir, "tmp_build"),
    }


def lock_sources(src_dir):
    """Sources (harnais compris) illisibles par l'etudiant — root, 700.

    Ne SUIT AUCUN lien : root qui parcourt un lien pose par l'etudiant verrouillait la cible —
    tout le systeme de fichiers du conteneur pour un lien vers /. Une racine qui est un lien
    est ignoree ; un lien rencontre est change sans etre suivi (lchown), jamais chmode."""
    if os.path.islink(src_dir):
        return
    for root, dirs, files in os.walk(src_dir):
        for name in dirs + files:
            path = os.path.join(root, name)
            os.chown(path, 0, 0, follow_symlinks=False)
            if not os.path.islink(path):
                os.chmod(path, 0o700)
    os.chown(src_dir, 0, 0)
    os.chmod(src_dir, 0o700)


def first_lines(text, pattern, count=6):
    """Les quelques lignes à partir du premier match (détail d'échec lisible)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if re.search(pattern, line):
            return "\n".join(lines[i:i + count])[:1500]
    return None


class CaseOutcome:
    def __init__(self, passed, detail=None, ran=False, timed_out=False, skipped=False,
                 killed=False, cause=None, harness_build=False):
        self.passed = passed
        # Le NOTEUR (bouchons générés + harnais) n'a pas compilé, le code soumis si. Pour un
        # canari, dont le harnais est fixe, la cause est forcément le générateur de bouchons :
        # cause non concluante, jamais une accusation (cf. inconclusive).
        self.harness_build = harness_build
        # Cause d'un saut : "erreur" (superviseur), "budget" (budget global), "espace" (disque
        # sature par le code soumis). Seules les deux premieres peuvent ne pas etre imputables.
        self.cause = cause
        self.detail = detail
        self.ran = ran  # le run a eu lieu (≠ échec de compilation) — utilisé par les canaris
        self.timed_out = timed_out  # temps limite dépassé — utilisé par le verdict des canaris
        self.skipped = skipped  # cas SAUTÉ faute de budget global (ni tenté, ni fautif)
        self.killed = killed  # mort PAR SIGNAL (OOM, SIGSEGV) — cause non concluante


def exception_cause(e):
    """Cause d'une exception attrapee pendant un cas : "environnement" ou "erreur". PURE (testee).

    Une OSError vient de l'ENVIRONNEMENT — disque plein, lien pose dans /box, table des processus
    saturee — que l'etudiant partage et peut provoquer : elle reste une note. Toute autre
    exception est un bogue de LOGIQUE du superviseur, que le code soumis ne peut pas choisir de
    declencher : seule celle-la rend la notation incomplete (502, tentative a reprendre)."""
    return "environnement" if isinstance(e, OSError) else "erreur"


def job_incomplete(canaries, real_cases):
    """Le JOB est-il « incomplet » (502 sur le chemin interne) ? PURE (testee).

    Un verdict de FALSIFICATION l'emporte toujours : des canaris incoherents ne deviennent jamais
    une tentative a reprendre, meme si un cas a aussi subi une erreur interne."""
    return canaries != "incoherents" and grading_incomplete(real_cases)


def grader_killed(code, passed):
    """Le NOTEUR est-il mort par signal (OOM...) sans verdict ? PURE (testee).

    Cause NON CONCLUANTE : un canari « pass » tue par manque de memoire passait sinon pour un
    canari en echec, et faisait accuser de falsification une soumission dont un vrai cas avait
    reussi."""
    return code is not None and code < 0 and not passed


def grading_incomplete(real_cases):
    """La notation des cas REELS est-elle incomplete pour une cause NON IMPUTABLE ? PURE (testee).

    Vrai SEULEMENT si un cas a subi une erreur interne du superviseur : notre code a leve, ce
    n'est jamais la faute de l'etudiant. Execution-service en fait un 502 sur le chemin
    INTERNE — la tentative est supprimee, l'etudiant resoumet.

    Un budget global epuise reste IMPUTABLE (note partielle), sans exception : dans le conteneur,
    l'attente d'une place a deja eu lieu avant le demarrage, et le budget ne mesure que les
    compilations et les executions. Une solution correcte mais lente, ou une question a
    beaucoup de cas, l'epuise donc de facon REPRODUCTIBLE — en faire un 502 rendait la question
    impossible a noter et bloquait une place a chaque renvoi. Un disque sature (cause « espace »)
    reste imputable aussi : c'est le code soumis qui ecrit."""
    return any(o.cause == "erreur" for o in real_cases)


# Début de TOUT message d'échec de compilation du noteur (voir CaseOutcome.harness_build).
HARNESS_BUILD_ERROR = "Le harnais ne compile pas"
# Compilation du noteur EXPIRÉE ou TUÉE (temps limite, mémoire) : rien ne prouve que le harnais
# est faux. Préfixe distinct pour que deploy/check-compiled-harnesses.py ne ferme pas un quiz
# correct sur une machine chargée ; même drapeau harness_build (cause non concluante).
HARNESS_BUILD_ABORTED = "Le harnais n'a pas fini de compiler"


def harness_build_failure(expired, code, against, diagnostic):
    """Message d'échec de compilation du NOTEUR. FONCTION PURE (testée).

    Une compilation expirée ou tuée par signal (code < 0) n'est pas un diagnostic du
    compilateur : elle reçoit HARNESS_BUILD_ABORTED, jamais HARNESS_BUILD_ERROR."""
    if expired or (code is not None and code < 0):
        return (HARNESS_BUILD_ABORTED + " (temps limite de compilation dépassé ou compilateur "
                "arrêté) : rejouer la correction.")
    return HARNESS_BUILD_ERROR + " " + against + " :\n" + diagnostic


def is_harness_build_failure(detail):
    """Le détail vient-il d'un échec de compilation du NOTEUR ? FONCTION PURE (testée)."""
    return (detail or "").startswith((HARNESS_BUILD_ERROR, HARNESS_BUILD_ABORTED))


def inconclusive(outcome):
    """L'échec de ce cas a-t-il une cause NON CONCLUANTE ? FONCTION PURE (testée).

    Temps limite dépassé ou mort par signal : on ne peut rien en déduire sur l'intention.
    Le verdict des canaris s'en sert pour ne pas accuser — wrapper_verdict prend déjà soin
    de ne pas accuser un processus tué après les tests, et canary_verdict défaisait cette
    précaution par l'autre porte."""
    return outcome.timed_out or outcome.killed or outcome.harness_build


# Nom du test canari tiré au sort, par index de cas (vide pour un cas réel). Sert à
# NONCE du verdict, un par cas : le noteur l'imprime sur SON stderr quand le harnais du prof
# renvoie vrai, et lui seul le connaît. `redact_tokens` l'efface des sorties rendues.
TOKENS = {}


def redact_tokens(detail):
    """Retire TOUT jeton du détail renvoyé à l'appelant. FONCTION PURE (testée).

    Le détail est construit à partir des premières lignes de la sortie du cas : quand le
    verdict échoue tôt, la ligne `[MOODIT] jeton=… code=…` s'y retrouvait telle quelle et
    repartait vers core (journaux, détail affiché au prof). Un jeton ne vaut que pour SON cas
    et SON conteneur, donc l'exposition est bornée — mais un secret de notation n'a rien à
    faire dans un message, et les détails pourraient un jour être montrés à l'étudiant."""
    if not detail:
        return detail
    cleaned = detail
    for token in TOKENS.values():
        if token:
            cleaned = cleaned.replace(token, "…")
    return cleaned


def prep_run(case_dir, src):
    """Après compilation : sources ET caches de build verrouillés — gocache, dépôt cargo,
    target, HOME/TMP de compilation contiennent des copies des sources substituées (jeton,
    canaris), leur lecture par l'étudiant serait une extraction silencieuse. Les artefacts à
    exécuter sont rouverts ensuite (open_artifacts / chmod du binaire)."""
    lock_sources(src)
    for cache in (os.path.join(BOX, "gocache"), os.path.join(BOX, "cargo"),
                  os.path.join(case_dir, "target"), os.path.join(case_dir, "home_build"),
                  os.path.join(case_dir, "tmp_build")):
        if os.path.isdir(cache) and not os.path.islink(cache):
            lock_sources(cache)
    os.chmod(case_dir, 0o755)
    os.chmod(os.path.join(BOX, "cases"), 0o755)
    student_dir(case_dir, "work")


def run_c(case_dir, env, timeout_s, case_index):
    """Notation d'un cas C : harnais booleen, deux programmes, deux UID."""
    # gnu17, comme le mode « Executer » : en ISO strict (-std=c17), M_PI ou strdup passaient
    # au bouton « Executer » et echouaient a la notation — meme code, deux verdicts.
    return run_c_rpc(case_dir, env, timeout_s, case_index, "gcc", "-std=gnu17", "c")


def run_cpp(case_dir, env, timeout_s, case_index):
    """Notation d'un cas C++ : harnais booleen, deux programmes, deux UID."""
    return run_c_rpc(case_dir, env, timeout_s, case_index, "g++", "-std=c++20", "cpp")


def harness_rpc_body(case_dir):
    """Corps du harnais BOOLÉEN d'un cas, ou None si aucun fichier marqué n'est présent.

    Le marqueur est posé par HarnessProjects. C'est la SEULE forme notée : un harnais au format
    framework est refusé en amont, par ExecutionService, et n'arrive jamais ici."""
    src = os.path.join(case_dir, "src")
    if not os.path.isdir(src):
        return None
    for ident in sorted(os.listdir(src)):
        fpath = os.path.join(src, ident)
        if not os.path.isfile(fpath):
            continue
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                body_text = f.read()
        except OSError:
            continue
        if "__MOODIT_HARNAIS__" in body_text:
            return body_text.split("__MOODIT_HARNAIS__", 1)[1].lstrip("\n")
    return None


def run_java(case_dir, env, timeout_s, case_index):
    """Notation d'un cas Java : harnais booleen, deux programmes, deux UID."""
    return run_java_rpc(case_dir, env, timeout_s, case_index)


def run_csharp(case_dir, env, timeout_s, case_index):
    """Notation d'un cas C# : harnais booleen, deux programmes, deux UID."""
    return run_csharp_rpc(case_dir, env, timeout_s, case_index)


def run_go(case_dir, env, timeout_s, case_index):
    """Notation d'un cas Go : harnais booleen, deux programmes, deux UID."""
    return run_go_rpc(case_dir, env, timeout_s, case_index)


RUST_TEST_START = re.compile(r"test \S+ \.\.\. ")
# « FAILED » de libtest, quelle que soit sa position : collé au marqueur de début, ou seul sur
# sa ligne quand la sortie du test s'est terminée par un saut de ligne.
RUST_FAILED = re.compile(r"(?m)(?:^|\.\.\. )FAILED\s*$")
RUST_SUMMARY = re.compile(
    r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", re.M)


def run_rust(case_dir, env, timeout_s, case_index):
    """Notation d'un cas Rust : harnais booleen, deux programmes, deux UID."""
    return run_rust_rpc(case_dir, env, timeout_s, case_index)


# ──────────── NOTATION NON FALSIFIABLE DES COMPILÉS : RPC À DEUX PROCESSUS ────────────
#
# Le harnais du prof redevient un CORPS QUI RENVOIE UN BOOLÉEN (la forme d'avant #116). Ce qui
# change, c'est qu'il n'est plus compilé avec le code de l'étudiant : il vit dans un PROCESSUS
# DISTINCT, sous un UID DISTINCT, avec le nonce. Le code noté ne peut donc ni le lire, ni le
# modifier, ni forger le verdict — il n'habite pas le processus qui le rend.
#
# C'est la propriété que les langages INTERPRÉTÉS tiennent déjà (cf. CodeAssembler : noteur +
# serveur étudiant, nonce dans le noteur), transposée aux compilés. Les cinq attaques trouvées en
# revue — lecture d'un artefact, détournement d'un flux, interposition de printf, dup2,
# /proc/self/mem — deviennent SANS OBJET : il n'y a plus aucun secret dans le processus de
# l'étudiant. Elles ne sont plus « détectées », elles sont impossibles.
#
# Les bouchons d'appel exigent des SIGNATURES. On ne les devine pas et le prof n'a rien à
# déclarer : on compile le code étudiant SEUL, puis on lit ses signatures avec javap.

# `static` suffit, la visibilite n est PAS exigee : `static int doubler(int n)` — sans `public` —
# est du Java normal, surtout dans un exercice a une seule classe, et le refuser mettait en echec
# une soumission correcte. Le serveur invoque par reflexion (setAccessible), et le bouchon du
# noteur est une classe separee qui declare la methode publique de son cote.
# Modificateurs Java d une methode, ENUMERES et non significatifs (ordre quelconque) :
# `static final int f(int)` et `synchronized int g()` sont du code legal, et les refuser
# mettait en echec une soumission correcte. Enumeres, et non `\w+` : n importe quel mot
# aurait laisse un appel passer pour une declaration.
JAVA_MODS = (r"(?:public|protected|private|static|final|synchronized|native|strictfp"
             r"|abstract|default)")
# `static` present : chemin FONCTION.
PACKAGE_JAVA = re.compile(r"^[ \t]*package\s+[\w.]+\s*;", re.M)


JAVAP_SIGNATURE = re.compile(
    r"^[ \t]+(?=(?:" + JAVA_MODS + r"\s+)*static\s)(?:" + JAVA_MODS + r"\s+)*"
    r"([\w.$\[\]]+)\s+(\w+)\(([^()]*)\)(?:\s+throws\s+[^;]+)?;", re.M)

# Types marshalables par le protocole de ce premier jalon. Une méthode qui en sort n'est PAS
# proxifiée : le harnais qui l'appelle échoue alors à la compilation — message clair pour le
# prof, jamais un faux verdict pour l'étudiant.
JSON_TYPES = {"int": "Integer", "long": "Long", "double": "Double", "boolean": "Boolean",
              "java.lang.String": "String"}

# Nom de la méthode RPC du noteur par type de retour. `long`, `double` et `boolean` sont des MOTS
# RÉSERVÉS Java : dériver le nom du type (`JSON_TYPES[t].lower()`) produisait `MooditRpc.double(…)`,
# que javac refuse — seuls `int` et `String` compilaient. Le runtime les nomme donc avec un
# souligné final, et cette table est la seule source de vérité (statique et méthode d'instance).
JAVA_RPC_FN = {"Integer": "integer", "Long": "long_", "Double": "double_",
               "Boolean": "boolean_", "String": "string"}


def rpc_name(ident, types):
    """Nom porte sur le fil RPC Java et C# : `f(int,double)`. PURE (testee).

    Le nom et l'arite seuls ne choisissaient pas une surcharge : avec `f(int)` et `f(double)`
    dans le code soumis, le serveur prenait la premiere de meme arite (ordre non specifie
    par la reflexion), et une reponse juste pouvait etre notee fausse, pas toujours de la
    meme facon. Le serveur compare maintenant la liste des types, comme `c_dispatch_key`."""
    return "%s(%s)" % (ident, ",".join(types))


def java_nameable_class(binary_name):
    """Vrai si la classe compilee peut etre NOMMEE dans du source Java. PURE (testee).

    Une classe anonyme (`Solution$1`) ou locale (`Solution$1Aide`) a un segment qui commence
    par un chiffre : son bouchon (`class 1 { ... }`) n'etait pas du Java valide, le noteur ne
    compilait plus, et une reponse juste etait notee 0 -- pour un `new Comparator<>() { ... }`,
    idiome courant. Le harnais ne peut de toute facon pas ecrire ces classes."""
    return all(part.isidentifier() for part in (binary_name or "").split("$"))


JAVAP_CLASS = re.compile(r"^(?:public\s+)?(?:final\s+|abstract\s+)?class\s+([\w.$]+)", re.M)
# La visibilite n est PAS exigee, ici non plus : `class Rectangle { Rectangle(int,int){} }`
# est l ecriture la plus courante d un exercice a un seul fichier, et le serveur sait deja
# l invoquer (getDeclaredConstructors/getDeclaredMethods + setAccessible). Une methode
# STATIQUE ne peut pas etre prise pour une methode d instance : son `static` ajoute un
# jeton, donc le nom ne colle plus a la parenthese.
JAVAP_CTOR = re.compile(
    r"^[ \t]+(?:public\s+|protected\s+|private\s+)?([\w.$]+)\(([^()]*)\)(?:\s+throws\s+[^;]+)?;", re.M)
# `static` ABSENT : chemin OBJET. Sans cette anticipation, une statique serait proxifiee
# comme une methode d instance et le bouchon appellerait une poignee inexistante.
JAVAP_METHOD = re.compile(
    r"^[ \t]+(?!(?:" + JAVA_MODS + r"\s+)*static\s)(?:" + JAVA_MODS + r"\s+)*"
    r"([\w.$\[\]]+)\s+(\w+)\(([^()]*)\)(?:\s+throws\s+[^;]+)?;", re.M)


def java_class_api(javap_output):
    """API OBJET d'une classe compilée → (nom source, [constructeurs], [méthodes d'instance]).

    FONCTION PURE (testée). Permet de proxifier `new Rectangle(3, 4).aire()` : le harnais du prof
    garde l'écriture naturelle, mais l'objet VIT dans le processus de l'étudiant — le noteur n'en
    manipule qu'une POIGNÉE. Les types non marshalables écartent la signature concernée, jamais la
    classe entière.

    `nom source` : les classes imbriquées sont compilées en `Outer$Inner` ; le harnais les écrit
    `Outer.Inner`, et c'est cette forme qu'on rend."""
    klass = JAVAP_CLASS.search(javap_output or "")
    if not klass:
        return None, [], []
    binary_name = klass.group(1)
    if not java_nameable_class(binary_name):
        return None, [], []
    simple = binary_name.split("$")[-1]
    ctors = []
    for ident, args in JAVAP_CTOR.findall(javap_output):
        if ident.split("$")[-1] != simple and ident != binary_name:
            continue
        types = [a.strip() for a in args.split(",") if a.strip()]
        if all(t in JSON_TYPES for t in types):
            ctors.append(types)
    method_list = []
    for ret, ident, args in JAVAP_METHOD.findall(javap_output):
        if ident == "main" or ret not in JSON_TYPES:
            continue
        types = [a.strip() for a in args.split(",") if a.strip()]
        if all(t in JSON_TYPES for t in types):
            method_list.append((ret, ident, types))
    # Les méthodes STATIQUES sont déjà proxifiées par java_signatures : on ne garde ici que
    # l'instance, pour ne pas générer deux fois le même bouchon.
    statics = {(r, n, tuple(t)) for r, n, t in java_signatures(javap_output)}
    method_list = [m for m in method_list if (m[0], m[1], tuple(m[2])) not in statics]
    return binary_name.replace("$", "."), ctors, method_list


def java_object_stub(source_name, ctors, method_list):
    """Bouchon d'une classe OBJET : constructeur → poignée, méthodes → appel sur la poignée.

    FONCTION PURE (testée). Une classe imbriquée (`Outer.Inner`) est rendue dans sa coquille, pour
    que le harnais puisse l'écrire exactement comme l'étudiant l'a déclarée."""
    simple = source_name.split(".")[-1]
    body = ["    public static final class " + simple + " {",
             "        private final int __h;"]
    for types in ctors or [[]]:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        body += ["        public %s(%s) {" % (simple, params),
                  "            this.__h = MooditRpc.nouvelle(\"%s\", new Object[]{%s});"
                  % (rpc_name(source_name, types), args),
                  "        }"]
    for ret, ident, types in method_list:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        body += ["        public %s %s(%s) {" % (ret, ident, params),
                  "            return MooditRpc.%s(__h, \"%s\", new Object[]{%s});"
                  % ("m" + JSON_TYPES[ret].lower(), rpc_name(ident, types), args),
                  "        }"]
    body.append("    }")
    return "\n".join(body)


def java_signatures(javap_output):
    """Méthodes STATIQUES du code étudiant → [(retour, nom, [types])], visibilité indifférente.

    FONCTION PURE (testée). `main` est écartée (point d'entrée, pas une API notée), ainsi que
    toute signature dont un type n'est pas marshalable."""
    hits = []
    for ret, ident, args in JAVAP_SIGNATURE.findall(javap_output or ""):
        if ident == "main":
            continue
        types = [a.strip() for a in args.split(",") if a.strip()]
        if ret not in JSON_TYPES or any(t not in JSON_TYPES for t in types):
            continue
        hits.append((ret, ident, types))
    return dedupe_signatures(hits)


def dedupe_signatures(signatures):
    """Une signature (nom, types) une seule fois, la PREMIERE vue. PURE (testee).

    Java et C# aplatissent dans UNE classe de bouchons les statiques de toutes les classes du
    code soumis : `Solution.calcul(int)` et une classe d'aide `Aide.calcul(int)` donnaient deux
    bouchons identiques, que le compilateur refusait — une reponse juste notee 0, avec un
    message qui accusait le harnais du prof."""
    seen, result = set(), []
    for ret, ident, types in signatures:
        dedup_key = (ident, tuple(types))
        if dedup_key not in seen:
            seen.add(dedup_key)
            result.append((ret, ident, types))
    return result


def java_stub_source(class_name, methods, objects=(), self_ctors=(), self_instance=()):
    """Classe-BOUCHON compilée avec le harnais : mêmes signatures, corps = appel RPC.

    FONCTION PURE (testée). Le harnais du prof compile contre elle sans rien savoir ; aucune
    ligne de code étudiant n'entre dans ce programme. `objects` apporte les classes IMBRIQUÉES
    proxifiées par poignée, pour que `new Solution.Rectangle(3, 4).aire()` s'écrive naturellement
    alors que l'objet vit, lui, dans le processus de l'étudiant."""
    src_lines = ["public final class " + class_name + " {"]
    if self_ctors and self_instance:
        # La classe de premier niveau EST l'objet : c'est le cas d'une question POO dont la
        # classe publique est `Rectangle`, et le harnais écrit `new Rectangle(3, 4).aire()`.
        src_lines.append("    private final int __h;")
        for types in self_ctors or [[]]:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            src_lines += ["    public %s(%s) {" % (class_name, params),
                       "        this.__h = MooditRpc.nouvelle(\"%s\", new Object[]{%s});"
                       % (rpc_name(class_name, types), args),
                       "    }"]
        for ret, ident, types in self_instance:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            src_lines += ["    public %s %s(%s) {" % (ret, ident, params),
                       "        return MooditRpc.%s(__h, \"%s\", new Object[]{%s});"
                       % ("m" + JSON_TYPES[ret].lower(), rpc_name(ident, types), args),
                       "    }"]
    else:
        src_lines.append("    private " + class_name + "() {}")
    top_level = []
    for source_name, ctors, instance in objects:
        if "." in source_name:
            # Classe IMBRIQUEE (Solution.Rectangle) : dans sa coquille, comme l'etudiant l'a ecrite.
            src_lines.append(java_object_stub(source_name, ctors, instance))
        else:
            top_level.append(java_object_stub(source_name, ctors, instance))
    for ret, ident, types in methods:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        src_lines += ["    public static %s %s(%s) {" % (ret, ident, params),
                   "        return MooditRpc.%s(\"%s\", new Object[]{%s});"
                   % (JAVA_RPC_FN[JSON_TYPES[ret]], rpc_name(ident, types), args),
                   "    }"]
    src_lines.append("}")
    # Classe de PREMIER NIVEAU (`class Rectangle` a cote de Solution) : hors de la coquille, en
    # classe non publique du meme fichier. Rangee dans Solution, elle devenait Solution.Rectangle
    # et le harnais `new Rectangle(3, 4)` ne compilait plus — 0 pour toute la question.
    for stub_src in top_level:
        src_lines.append(stub_src.replace("    public static final class ", "final class ", 1))
    return "\n".join(src_lines) + "\n"


# Types PUBLICS de premier niveau de java.lang (JDK 25). Le bouchon recopie les classes de
# premier niveau du code soumis dans le paquet du NOTEUR ; un type du meme paquet l'emporte sur
# l'import implicite de java.lang. Une `class StringBuffer` soumise detournait donc vers le code
# note le `new StringBuffer(...)` dont le harnais se sert pour calculer l'attendu.
JAVA_LANG_TYPES = frozenset("""
    Appendable AutoCloseable CharSequence Cloneable Comparable Iterable Readable Runnable
    Boolean Byte Character Class ClassLoader ClassValue Compiler Double Enum Float IO
    InheritableThreadLocal Integer Long Math Module ModuleLayer Number Object Package Process
    ProcessBuilder ProcessHandle Record Runtime RuntimePermission ScopedValue SecurityManager
    Short StackTraceElement StackWalker StrictMath String StringBuffer StringBuilder
    StringTemplate System Thread ThreadGroup ThreadLocal Throwable Void
    ArithmeticException ArrayIndexOutOfBoundsException ArrayStoreException ClassCastException
    ClassNotFoundException CloneNotSupportedException EnumConstantNotPresentException Exception
    IllegalAccessException IllegalArgumentException IllegalCallerException
    IllegalMonitorStateException IllegalStateException IllegalThreadStateException
    IndexOutOfBoundsException InstantiationException InterruptedException
    LayerInstantiationException MatchException NegativeArraySizeException NoSuchFieldException
    NoSuchMethodException NullPointerException NumberFormatException
    ReflectiveOperationException RuntimeException SecurityException
    StringIndexOutOfBoundsException TypeNotPresentException UnsupportedOperationException
    WrongThreadException
    AbstractMethodError AssertionError BootstrapMethodError ClassCircularityError
    ClassFormatError Error ExceptionInInitializerError IllegalAccessError
    IncompatibleClassChangeError InstantiationError InternalError LinkageError
    NoClassDefFoundError NoSuchFieldError NoSuchMethodError OutOfMemoryError
    StackOverflowError ThreadDeath UnknownError UnsatisfiedLinkError
    UnsupportedClassVersionError VerifyError VirtualMachineError
    Deprecated FunctionalInterface Override SafeVarargs SuppressWarnings
""".split())


def java_shadowed_names(class_names, harness_code):
    """Classes de premier niveau soumises qui masqueraient, dans le noteur, un type de
    java.lang que le HARNAIS emploie. PURE (testée).

    Seul l'emploi par le harnais rend le nom ambigu : une `class Process` que le harnais ne
    nomme pas ne detourne rien, et la refuser mettrait 0 a une reponse juste."""
    bare = blank_code(harness_code or "")
    return [n for n in dict.fromkeys(class_names)
            if n in JAVA_LANG_TYPES and re.search(r"\b%s\b" % re.escape(n), bare)]


def java_grader_source(harness_code, nonce):
    """Programme NOTEUR : runtime RPC + harnais booléen du prof + nonce.

    FONCTION PURE (testée). stdin/stdout sont le tube vers le processus étudiant ; le nonce part
    sur stderr, que l'étudiant ne tient pas. Une exception du harnais vaut faux (fail-closed)."""
    return """import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

final class MooditRpc {
    private static final BufferedReader ENTREE =
            new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    private static final PrintStream SORTIE = System.out;

    private MooditRpc() {}

    private static final java.security.SecureRandom ALEA = new java.security.SecureRandom();

    /**
     * Un appel = une ligne JSON vers le processus étudiant, une ligne JSON en retour.
     *
     * Chaque appel porte un IDENTIFIANT IMPRÉVISIBLE que la réponse doit renvoyer. Sans lui, le
     * code noté — dont le stdout EST le canal de réponse — n'avait qu'à imprimer
     * {"ok":true,"value":<attendu>} avant même d'être appelé : le noteur consommait cette ligne
     * comme réponse et le harnais passait au vert sur un code faux. Il doit maintenant répondre
     * à la question posée, et il ne peut pas la devancer.
     */
    /** Envoie la requête et attend LA réponse portant cet identifiant. */
    private static String attend(String id, String requete) {
        SORTIE.println(requete);
        SORTIE.flush();
        try {
            String ligne;
            String marqueur = "\\"id\\":\\"" + id + "\\"";
            while ((ligne = ENTREE.readLine()) != null) {
                // Le code étudiant partage stdout avec les réponses : seule une réponse portant
                // l'identifiant DE CET APPEL compte. Tout le reste est du bruit (ou une tentative
                // de devancer la question) et est ignoré.
                if (ligne.startsWith("{\\"ok\\":") && ligne.contains(marqueur)) { return ligne; }
            }
        } catch (Exception e) {
            // tombe dans l'échec ci-dessous
        }
        throw new RuntimeException("processus etudiant termine");
    }

    private static String echange(String nom, Object[] args) {
        String id = Long.toHexString(ALEA.nextLong()) + Long.toHexString(ALEA.nextLong());
        StringBuilder b = new StringBuilder("{\\"op\\":\\"call\\",\\"id\\":\\"").append(id)
                .append("\\",\\"name\\":\\"").append(nom)
                .append("\\",\\"args\\":[");
        for (int i = 0; i < args.length; i++) {
            if (i > 0) { b.append(','); }
            b.append(litteral(args[i]));
        }
        return attend(id, b.append("]}").toString());
    }

    private static String litteral(Object o) {
        if (o instanceof String) {
            // Hexadécimal : un ], un " ou une barre oblique inverse dans la valeur cassait
            // l'analyse côté serveur, et une réponse JUSTE était notée fausse.
            return "\\"" + hexe((String) o) + "\\"";
        }
        return String.valueOf(o);
    }

    private static String valeur(String reponse) {
        if (reponse.contains("\\"ok\\":false")) {
            // On relaie le message de l'etudiant : c'est le diagnostic du prof (exception dans
            // la fonction notee, methode absente, type inattendu). Aucun secret n'y transite.
            throw new RuntimeException("appel refuse par le code soumis : " + reponse);
        }
        int i = reponse.indexOf("\\"value\\":");
        if (i < 0) { throw new RuntimeException("reponse sans valeur"); }
        String v = reponse.substring(i + 8).trim();
        if (v.endsWith("}")) { v = v.substring(0, v.length() - 1).trim(); }
        return v;
    }

    /** Construit un objet CHEZ L'ÉTUDIANT et n'en rapporte qu'une poignée. */
    static int nouvelle(String classe, Object[] args) {
        String id = Long.toHexString(ALEA.nextLong()) + Long.toHexString(ALEA.nextLong());
        StringBuilder b = new StringBuilder("{\\"op\\":\\"new\\",\\"id\\":\\"").append(id)
                .append("\\",\\"class\\":\\"").append(classe).append("\\",\\"args\\":[");
        for (int i = 0; i < args.length; i++) {
            if (i > 0) { b.append(','); }
            b.append(litteral(args[i]));
        }
        return Integer.parseInt(valeur(attend(id, b.append("]}").toString())));
    }

    private static String appelMethode(int handle, String nom, Object[] args) {
        String id = Long.toHexString(ALEA.nextLong()) + Long.toHexString(ALEA.nextLong());
        StringBuilder b = new StringBuilder("{\\"op\\":\\"method\\",\\"id\\":\\"").append(id)
                .append("\\",\\"handle\\":").append(handle)
                .append(",\\"name\\":\\"").append(nom).append("\\",\\"args\\":[");
        for (int i = 0; i < args.length; i++) {
            if (i > 0) { b.append(','); }
            b.append(litteral(args[i]));
        }
        return attend(id, b.append("]}").toString());
    }

    static int minteger(int h, String n, Object[] a) { return Integer.parseInt(valeur(appelMethode(h, n, a))); }
    static long mlong(int h, String n, Object[] a) { return Long.parseLong(valeur(appelMethode(h, n, a))); }
    static double mdouble(int h, String n, Object[] a) { return Double.parseDouble(valeur(appelMethode(h, n, a))); }
    static boolean mboolean(int h, String n, Object[] a) { return Boolean.parseBoolean(valeur(appelMethode(h, n, a))); }
    static String mstring(int h, String n, Object[] a) {
        // Même règle que string() : un JSON null est un null Java, pas le texte « null ».
        String v = valeur(appelMethode(h, n, a));
        if (v.equals("null")) { return null; }
        return dechaine(v);
    }

    static int integer(String nom, Object[] args) { return Integer.parseInt(valeur(echange(nom, args))); }
    static long long_(String nom, Object[] args) { return Long.parseLong(valeur(echange(nom, args))); }
    static double double_(String nom, Object[] args) { return Double.parseDouble(valeur(echange(nom, args))); }
    static boolean boolean_(String nom, Object[] args) { return Boolean.parseBoolean(valeur(echange(nom, args))); }
    static String string(String nom, Object[] args) {
        String v = valeur(echange(nom, args));
        // JSON null (sans guillemets) = la fonction a rendu null. Livre comme le TEXTE
        // « null », `== null` etait note faux et `"null".equals(...)` vrai — un faux verdict
        // SILENCIEUX. Une vraie chaine "null" voyage, elle, entre guillemets (puis en hexa).
        if (v.equals("null")) { return null; }
        return dechaine(v);
    }

    private static String dechaine(String v) {
        if (v.length() >= 2 && v.startsWith("\\"")) { v = v.substring(1, v.length() - 1); }
        return dehexe(v);
    }

    /** Mêmes codecs que le serveur : la chaîne ne voyage qu'en hexadécimal. */
    private static String hexe(String s) {
        StringBuilder sb = new StringBuilder("H");
        for (byte x : s.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            sb.append(String.format("%02x", x));
        }
        return sb.toString();
    }

    private static String dehexe(String v) {
        v = v.trim();
        if (!v.startsWith("H")) { return v; }
        byte[] out = new byte[(v.length() - 1) / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(v.substring(1 + i * 2, 3 + i * 2), 16);
        }
        return new String(out, java.nio.charset.StandardCharsets.UTF_8);
    }

}

public final class MooditGrader {
    private static boolean harnais() throws Exception {
__CORPS__
    }

    public static void main(String[] args) {
        boolean ok;
        try {
            ok = harnais();
        } catch (Throwable t) {
            // fail-closed, mais JAMAIS en silence : un harnais qui lève doit le dire au prof
            // (c'est son code, pas celui de l'étudiant). Aucun secret ne transite par là.
            ok = false;
            // Texte relaye SANS saut de ligne : il contient des octets choisis par
            // l etudiant, et une ligne fabriquee est la matiere premiere d une forge.
            System.err.println("[MOODIT] harnais: "
                    + String.valueOf(t).replace((char) 10, ' ').replace((char) 13, ' '));
        }
        if (ok) {
            // Nonce sur STDERR : stdout est le tube vers l'étudiant, et l'étudiant ne tient
            // aucun descripteur sur ce flux-ci.
            System.err.println();
            System.err.println("__NONCE__");
            System.err.flush();
        }
        System.exit(ok ? 0 : 1);
    }
}
""".replace("__CORPS__", indent_java(harness_code)).replace("__NONCE__", nonce)


def indent_java(body):
    """Corps du harnais indenté dans la méthode. FONCTION PURE (testée)."""
    return "\n".join("        " + l if l.strip() else l for l in (body or "").splitlines())


def java_server_source(class_names):
    """Programme ÉTUDIANT : son code, plus une boucle qui répond aux appels par RÉFLEXION.

    FONCTION PURE (testée). Aucun nonce, aucun harnais, aucun attendu : ce processus ne peut
    rien apprendre du verdict, et rien de ce qu'il écrit ne peut le produire."""
    return """import java.lang.reflect.Method;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public final class MooditServer {
    public static void main(String[] args) throws Exception {
        BufferedReader entree =
                new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String ligne;
        while ((ligne = entree.readLine()) != null) {
            String reponse;
            try {
                reponse = traite(ligne);
            } catch (Throwable t) {
                // L'IDENTIFIANT DE L'APPEL doit figurer dans la réponse d'erreur comme dans la
                // réponse normale : le noteur n'accepte qu'une ligne portant celui de SON appel.
                // Sans lui, une exception du code soumis (division par zéro, NPE…) n'était jamais
                // consommée, les deux processus s'attendaient, et le cas consommait tout son temps
                // limite pour rendre « Interrompu » au lieu du vrai motif. Les cinq autres
                // langages tenaient déjà cet invariant.
                reponse = "{\\"ok\\":false,\\"id\\":\\"" + entre(ligne, "\\"id\\":\\"", "\\"")
                        + "\\",\\"error\\":\\"" + String.valueOf(t).replace('"', '\\'') + "\\"}";
            }
            // « Contrat du canal de réponse » (docker/runners/README.md) : referme une
            // éventuelle ligne partielle écrite par le code soumis, qui sinon se collait à
            // la réponse et la rendait méconnaissable.
            System.out.print("\\n" + reponse + "\\n");
            System.out.flush();
        }
    }

    /** Objets construits CHEZ L'ÉTUDIANT : le noteur n'en connaît que la poignée. */
    private static final java.util.List<Object> OBJETS = new java.util.ArrayList<>();

    private static String traite(String ligne) throws Exception {
        String op = entre(ligne, "\\"op\\":\\"", "\\"");
        if (op.equals("new")) { return construit(ligne); }
        if (op.equals("method")) { return methode(ligne); }
        String id = entre(ligne, "\\"id\\":\\"", "\\"");
        String appel = entre(ligne, "\\"name\\":\\"", "\\"");
        String nom = base(appel);
        String brut = entre(ligne, "\\"args\\":[", "]");
        Object[] args = decoupe(brut);
        Method cible = null;
        // TOUTES les classes du code soumis, principale d'abord : le bouchon aplatit les
        // statiques de toutes les classes dans la classe principale, la recherche doit couvrir
        // le meme perimetre — sinon une statique d'une classe secondaire etait declaree par le
        // bouchon puis introuvable ici, et une reponse juste etait notee 0.
        for (String __c : new String[] {__CLASSES__}) {
            for (Method m : Class.forName(__c).getDeclaredMethods()) {
                if (m.getName().equals(nom) && signe(m.getParameterTypes(), appel, args.length)) {
                    cible = m;
                    break;
                }
            }
            if (cible != null) { break; }
        }
        if (cible == null) { throw new NoSuchMethodException(nom); }
        cible.setAccessible(true);
        Object[] convertis = new Object[args.length];
        Class<?>[] types = cible.getParameterTypes();
        for (int i = 0; i < args.length; i++) { convertis[i] = convertit(types[i], (String) args[i]); }
        Object valeur = cible.invoke(null, convertis);
        return "{\\"ok\\":true,\\"id\\":\\"" + id + "\\",\\"value\\":" + encode(valeur) + "}";
    }

    private static String construit(String ligne) throws Exception {
        String id = entre(ligne, "\\"id\\":\\"", "\\"");
        String appel = entre(ligne, "\\"class\\":\\"", "\\"");
        String classe = base(appel).replace('.', '$');
        Object[] args = decoupe(entre(ligne, "\\"args\\":[", "]"));
        Class<?> cible = Class.forName(classe);
        for (java.lang.reflect.Constructor<?> c : cible.getDeclaredConstructors()) {
            if (!signe(c.getParameterTypes(), appel, args.length)) { continue; }
            c.setAccessible(true);
            Class<?>[] types = c.getParameterTypes();
            Object[] convertis = new Object[args.length];
            for (int i = 0; i < args.length; i++) {
                convertis[i] = convertit(types[i], (String) args[i]);
            }
            OBJETS.add(c.newInstance(convertis));
            return "{\\"ok\\":true,\\"id\\":\\"" + id + "\\",\\"value\\":" + (OBJETS.size() - 1) + "}";
        }
        throw new NoSuchMethodException("constructeur " + classe);
    }

    private static String methode(String ligne) throws Exception {
        String id = entre(ligne, "\\"id\\":\\"", "\\"");
        String appel = entre(ligne, "\\"name\\":\\"", "\\"");
        String nom = base(appel);
        int handle = Integer.parseInt(entre(ligne + ",", "\\"handle\\":", ",").trim());
        Object[] args = decoupe(entre(ligne, "\\"args\\":[", "]"));
        Object instance = OBJETS.get(handle);
        for (Method m : instance.getClass().getDeclaredMethods()) {
            if (!m.getName().equals(nom) || !signe(m.getParameterTypes(), appel, args.length)) {
                continue;
            }
            m.setAccessible(true);
            Class<?>[] types = m.getParameterTypes();
            Object[] convertis = new Object[args.length];
            for (int i = 0; i < args.length; i++) {
                convertis[i] = convertit(types[i], (String) args[i]);
            }
            return "{\\"ok\\":true,\\"id\\":\\"" + id + "\\",\\"value\\":"
                    + encode(m.invoke(instance, convertis)) + "}";
        }
        throw new NoSuchMethodException(nom);
    }

    /** Nom sans sa signature : `f(int,double)` donne `f`. */
    private static String base(String appel) {
        int p = appel.indexOf('(');
        return p < 0 ? appel : appel.substring(0, p);
    }

    /**
     * La surcharge VISEE par le bouchon : memes types de parametres, dans l'ordre. Le nom et
     * l'arite seuls prenaient la premiere de meme arite, et une reponse juste pouvait etre
     * notee fausse des que le code soumis declarait f(int) et f(double).
     */
    private static boolean signe(Class<?>[] types, String appel, int arite) {
        if (types.length != arite) { return false; }
        int p = appel.indexOf('(');
        if (p < 0) { return true; }
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < types.length; i++) {
            if (i > 0) { b.append(','); }
            b.append(types[i].getName());
        }
        return b.toString().equals(appel.substring(p + 1, appel.length() - 1));
    }

    private static Object convertit(Class<?> type, String brut) {
        String v = brut.trim();
        // JSON null (sans guillemets) = argument null. Une vraie chaîne « null » voyage entre
        // guillemets, en hexadécimal : sans ce cas, le null du harnais arrivait comme le TEXTE
        // « null » chez l'étudiant — `s == null` faux sur une réponse juste.
        if (v.equals("null") && !type.isPrimitive()) { return null; }
        if (type == int.class || type == Integer.class) { return Integer.valueOf(v); }
        if (type == long.class || type == Long.class) { return Long.valueOf(v); }
        if (type == double.class || type == Double.class) { return Double.valueOf(v); }
        if (type == boolean.class || type == Boolean.class) { return Boolean.valueOf(v); }
        if (v.length() >= 2 && v.startsWith("\\"")) { v = v.substring(1, v.length() - 1); }
        return dehexe(v);
    }

    /** Chaîne → HEXADÉCIMAL sur le fil. Un ] ou un " dans la valeur cassait l'analyse. */
    private static String hexe(String s) {
        StringBuilder sb = new StringBuilder("H");
        for (byte x : s.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            sb.append(String.format("%02x", x));
        }
        return sb.toString();
    }

    private static String dehexe(String v) {
        v = v.trim();
        if (!v.startsWith("H")) { return v; }
        byte[] out = new byte[(v.length() - 1) / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(v.substring(1 + i * 2, 3 + i * 2), 16);
        }
        return new String(out, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static String encode(Object valeur) {
        if (valeur instanceof String) {
            return "\\"" + hexe((String) valeur) + "\\"";
        }
        return String.valueOf(valeur);
    }

    private static String entre(String s, String debut, String fin) {
        int i = s.indexOf(debut);
        if (i < 0) { return ""; }
        int j = s.indexOf(fin, i + debut.length());
        return j < 0 ? "" : s.substring(i + debut.length(), j);
    }

    private static Object[] decoupe(String brut) {
        if (brut.trim().isEmpty()) { return new Object[0]; }
        java.util.List<String> parts = new java.util.ArrayList<>();
        boolean chaine = false;
        StringBuilder courant = new StringBuilder();
        for (int i = 0; i < brut.length(); i++) {
            char c = brut.charAt(i);
            if (c == '"') { chaine = !chaine; courant.append(c); }
            else if (c == ',' && !chaine) { parts.add(courant.toString()); courant.setLength(0); }
            else { courant.append(c); }
        }
        parts.add(courant.toString());
        return parts.toArray();
    }
}
""".replace("__CLASSES__", ", ".join(chr(34) + n + chr(34) for n in class_names))


# ─────────────────────────── Go : bouchon et aiguillage TYPÉS ───────────────────────────
# Go n'a pas de réflexion utilisable ici : les deux côtés sont générés à partir des signatures
# lues dans la source de l'étudiant. Le code noté part dans un BINAIRE séparé (le harnais n'est
# ni compilé avec lui, ni présent dans son système de fichiers).

GO_FUNC = re.compile(r"^func\s+(\w+)\s*\(([^()]*)\)\s*([\w\[\]\*\.]+)?\s*\{", re.M)
GO_TYPES = {"int": "int", "int64": "int64", "float64": "float64", "bool": "bool",
            "string": "string"}


# Identifiants PREDECLARES de Go (spécification, « Predeclared identifiers », Go 1.23) : une
# declaration de paquet du meme nom les masque dans tout le paquet, harnais compris.
GO_PREDECLARED = frozenset("""
    any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32
    int64 rune string uint uint8 uint16 uint32 uint64 uintptr true false iota nil append cap
    clear close complex copy delete imag len make max min new panic print println real recover
""".split())


def go_reserved_names(names):
    """Noms de fonctions soumises qui masqueraient un identifiant prédéclaré. PURE (testée)."""
    return [n for n in dict.fromkeys(names) if n in GO_PREDECLARED]


# Paquets importés par les programmes GÉNÉRÉS. En Go, un nom d'import et une déclaration de
# paquet ne peuvent pas coexister : une `func hex(n int) string` soumise faisait refuser le
# noteur (qui importe encoding/hex), une `func json…` le serveur — « le harnais ne compile pas »
# sur une réponse juste. Ces imports passent donc sous un alias `moodit_…`, sauf ceux que le
# harnais du PROF peut utiliser par leur nom (fmt, math, strings), réservés ci-dessous.
GO_GRADER_ALIASED = ("bufio", "crypto/rand", "encoding/hex", "encoding/json", "os")
GO_SERVER_ALIASED = ("bufio", "encoding/json", "fmt", "os", "strings")
GO_HARNESS_PACKAGES = frozenset(("fmt", "math", "strings"))


def go_alias_imports(template, packages):
    """Gabarit Go dont les imports `packages` passent sous l'alias `moodit_<nom>`. PURE (testée).

    Appliquée au GABARIT seul, avant l'insertion du harnais : le code du prof n'est jamais
    réécrit."""
    for path in packages:
        name = path.rsplit("/", 1)[-1]
        alias = "moodit_" + name
        line = '    "%s"\n' % path
        if line not in template:
            raise ValueError("import absent du gabarit : " + path)
        template = template.replace(line, '    %s "%s"\n' % (alias, path))
        template = re.sub(r"(?<![\w.])%s\." % re.escape(name), alias + ".", template)
    return template


def go_harness_package_names(names):
    """Noms soumis qui masqueraient un paquet que le harnais du prof utilise. PURE (testée)."""
    return [n for n in dict.fromkeys(names) if n in GO_HARNESS_PACKAGES]


def go_signatures(source):
    """Fonctions de premier niveau du code étudiant → [(retour, nom, [types])].

    FONCTION PURE (testée). On accepte `func f(a int, b int) int` et la forme groupée
    `func f(a, b int) int`. `main` est écartée, ainsi que toute signature dont un type n'est pas
    marshalable : le harnais qui l'appellerait ne compilerait pas — message au prof, jamais un
    faux verdict."""
    hits = []
    for ident, params, ret in GO_FUNC.findall(source or ""):
        if ident == "main" or (ret or "") not in GO_TYPES:
            continue
        types = []
        valid = True
        for param_group in [p.strip() for p in params.split(",") if p.strip()]:
            pieces = param_group.split()
            if len(pieces) == 2:
                types.append(pieces[1])
            elif len(pieces) == 1:
                types.append(None)          # type porté par le groupe suivant (a, b int)
            else:
                valid = False
        # Propagation à rebours des types groupés : (a, b int) → [int, int]
        last_item = None
        for i in range(len(types) - 1, -1, -1):
            if types[i] is None:
                types[i] = last_item
            else:
                last_item = types[i]
        if not valid or any(t not in GO_TYPES for t in types):
            continue
        hits.append((ret, ident, types))
    return hits


GO_STRUCT = re.compile(r"^type\s+(\w+)\s+struct\b", re.M)
GO_METHOD = re.compile(
    r"^func\s+\(\s*\w+\s+(\*?)(\w+)\s*\)\s*(\w+)\s*\(([^()]*)\)\s*([\w\[\]\*\.]+)?\s*\{", re.M)


def go_object_api(source):
    """API OBJET Go → [(type, [(nom de constructeur, [types])], [(retour, méthode, [types])])].

    FONCTION PURE (testée). Go n'a pas de constructeur, et DEUX formes sont proxifiées, parce que
    les deux sont l'idiome : la fonction qui renvoie la structure (`NewRectangle(3, 4)`), et le
    littéral à champs nommés (`Rectangle{largeur: 3, hauteur: 4}`), pris en charge par capture de
    champs (cf. go_object_stub). Un type sans méthode marshalable n'est pas proxifié : le harnais
    qui l'appelle ne compilera pas — message au prof, jamais un faux verdict."""
    field_list = go_capture_fields(source)
    structs = set(GO_STRUCT.findall(source or ""))
    if not structs:
        return []
    by_type = {s: ([], []) for s in structs}
    for ident, params, ret in GO_FUNC.findall(source or ""):
        # `func NewRectangle(…) *Rectangle` est la forme la plus répandue : sans retirer l'étoile,
        # ce constructeur n'était pas reconnu et la question n'était pas proxifiée.
        if (ret or "").lstrip("*") not in structs or ident == "main":
            continue
        types = _go_param_types(params)
        if types is not None:
            target_file = (ret or "").lstrip("*")
            by_type[target_file][0].append((ident, types, (ret or "").startswith("*")))
    for _, receiver, ident, params, ret in GO_METHOD.findall(source or ""):
        if receiver not in structs:
            continue
        if (ret or "") not in GO_TYPES:
            continue
        types = _go_param_types(params)
        if types is not None:
            by_type[receiver][1].append((ret, ident, types))
    return [(t, c, m) for t, (c, m) in sorted(by_type.items()) if m and (c or t in field_list)]


def _go_param_types(params):
    """Types des paramètres d'une signature Go, ou None si l'un n'est pas marshalable. PURE."""
    types = []
    for param_group in [p.strip() for p in params.split(",") if p.strip()]:
        pieces = param_group.split()
        if len(pieces) == 2:
            types.append(pieces[1])
        elif len(pieces) == 1:
            types.append(None)
        else:
            return None
    last_item = None
    for i in range(len(types) - 1, -1, -1):
        if types[i] is None:
            types[i] = last_item
        else:
            last_item = types[i]
    return types if all(t in GO_TYPES for t in types) else None


GO_RPC_RUNTIME = '''
type mooditReq struct {
    Op     string        `json:"op"`
    Id     string        `json:"id"`
    Name   string        `json:"name"`
    Handle int           `json:"handle"`
    Args   []interface{} `json:"args"`
}

type mooditRep struct {
    Ok    bool        `json:"ok"`
    Id    string      `json:"id"`
    Value interface{} `json:"value"`
    Error string      `json:"error"`
}
'''


GO_CONV = {"int": "int(mooditEntier(%s))", "int64": "mooditEntier(%s)",
           "float64": "mooditNombre(%s)", "bool": "%s.(bool)", "string": "%s.(string)"}


GO_STRUCT_BODY = re.compile(r"^type\s+(\w+)\s+struct\s*\{([^}]*)\}", re.M | re.S)


def go_struct_fields(source):
    """Champs des structures du code étudiant → {type: [(champ, type)]}. PURE (testée).

    Sert à proxifier l'IDIOME Go : `Rectangle{largeur: 3, hauteur: 4}`. Il n'y a pas de
    constructeur dans ce langage, donc exiger une fonction-constructeur écarterait la façon
    normale d'écrire — et c'est celle que les profs emploient."""
    field_list = {}
    for typ, body in GO_STRUCT_BODY.findall(source or ""):
        entries = []
        for src_line in body.splitlines():
            bare_line = src_line.split("//")[0].strip()
            if not bare_line:
                continue
            pieces = bare_line.replace(",", " ").split()
            if len(pieces) < 2 or pieces[-1] not in GO_TYPES:
                entries = None
                break
            for ident in pieces[:-1]:
                # Seul chemin ou du texte etudiant LIBRE entrait dans la source du NOTEUR :
                # contraint a un identifiant strict, tout le reste ecarte la structure.
                if not re.fullmatch(r"[A-Za-z_]\w*", ident):
                    entries = None
                    break
                entries.append((ident, pieces[-1]))
            if entries is None:
                break
        if entries:
            field_list[typ] = entries
    return field_list


def go_pointer_receivers(source):
    """Types dont au moins une méthode a un RÉCEPTEUR POINTEUR. FONCTION PURE (testée).

    Une telle méthode peut modifier l'objet. La capture de champs reconstruisant l'objet à chaque
    appel, la modification serait perdue EN SILENCE (verdict faux sans diagnostic) : ces types
    passent donc par la poignée d'un constructeur, ou ne sont pas proxifiés du tout."""
    return {receiver for star, receiver, _, _, _ in GO_METHOD.findall(source or "") if star}


def go_capture_fields(source):
    """Champs CAPTURABLES : ceux des structures sans méthode à récepteur pointeur. PURE (testée).

    Décision prise ICI et nulle part ailleurs : bouchon, aiguillage et lecture d'API doivent
    s'accorder, sinon un type est miroité d'un côté et traité par poignée de l'autre."""
    mutants = go_pointer_receivers(source)
    return {t: f for t, f in go_struct_fields(source).items() if t not in mutants}


def go_object_stub(obj_list, field_list=None):
    """Bouchons OBJET Go : littéral à champs capturés ou poignée, et méthodes relayées.

    FONCTION PURE (testée). Quand tous les champs sont marshalables, le bouchon les MIROITE :
    le harnais écrit son littéral habituel, et la méthode construit l'objet CHEZ l'étudiant au
    moment de l'appel. Une fonction-constructeur reste proxifiée dans ce mode — elle s'exécute
    chez l'étudiant et le bouchon RELIT les champs du résultat, ce qui garde la valeur simple et
    autorise aussi bien `NewRectangle(3, 4)` que le littéral. Sinon : poignée du constructeur."""
    field_list = field_list or {}
    pieces = []
    for typ, ctors, method_list in obj_list:
        if typ in field_list:
            pieces.append("type %s struct {\n%s\n}"
                            % (typ, "\n".join("    %s %s" % (n, t) for n, t in field_list[typ])))
            for ident, types, pointer in ctors:
                params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
                args = ", ".join("a%d" % i for i in range(len(types)))
                reads = ", ".join(
                    "%s: %s" % (n, GO_CONV[t] % ("mooditIndex(champs, %d)" % i))
                    for i, (n, t) in enumerate(field_list[typ]))
                # Le constructeur garde SA signature ici aussi : la branche à poignée le faisait
                # déjà, pas celle-ci, et un harnais qui rangeait le résultat dans un *T (ou le
                # comparait à nil) ne compilait que d'un côté.
                pieces.append('''func %s(%s) %s%s {
    champs := mooditChamps("%s", []interface{}{%s})
    return %s%s{%s}
}''' % (ident, params, "*" if pointer else "", typ, ident, args,
        "&" if pointer else "", typ, reads))
            vals = ", ".join("o.%s" % n for n, _ in field_list[typ])
            for ret, ident, types in method_list:
                params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
                args = ", ".join("a%d" % i for i in range(len(types)))
                conv = GO_CONV[ret] % (
                    'mooditMethode(int(mooditEntier(mooditNouvelle("%s", []interface{}{%s}))), '
                    '"%s.%s", []interface{}{%s})' % (typ, vals, typ, ident, args))
                pieces.append('''func (o %s) %s(%s) %s {
    return %s
}''' % (typ, ident, params, ret, conv))
            continue
        pieces.append("type %s struct {\n    __h int\n}" % typ)
        for ident, types, pointer in ctors:
            params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            # Le constructeur garde SA signature : `*Rectangle` s'il rend un pointeur, pour que
            # le harnais du prof s'écrive exactement comme avec le code de l'étudiant.
            pieces.append('''func %s(%s) %s%s {
    return %s%s{__h: int(mooditEntier(mooditNouvelle("%s", []interface{}{%s})))}
}''' % (ident, params, "*" if pointer else "", typ,
        "&" if pointer else "", typ, ident, args))
        for ret, ident, types in method_list:
            params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            conv = GO_CONV[ret] % 'mooditMethode(o.__h, "%s.%s", []interface{}{%s})' % (typ, ident, args)
            pieces.append('''func (o %s) %s(%s) %s {
    return %s
}''' % (typ, ident, params, ret, conv))
    return "\n\n".join(pieces)


def go_object_dispatch(obj_list, field_list=None):
    """Aiguillage OBJET côté étudiant : construit et appelle POUR DE VRAI. PURE (testée).

    Un type à champs capturés se construit par son littéral, exactement comme le ferait
    l'étudiant ; la clé `new` porte alors le NOM DU TYPE, et non celui d'un constructeur."""
    field_list = field_list or {}
    new_branch, method_branch = [], []
    for typ, ctors, method_list in obj_list:
        if typ in field_list:
            assignments = ", ".join(
                "%s: %s" % (n, GO_CONV[t] % ("req.Args[%d]" % i))
                for i, (n, t) in enumerate(field_list[typ]))
            new_branch.append('        case "%s":\n'
                           '            mooditObjets = append(mooditObjets, &%s{%s})\n'
                           '            valeur = len(mooditObjets) - 1'
                           % (typ, typ, assignments))
            # Une fonction-constructeur renvoie les CHAMPS du résultat, pas une poignée : le
            # bouchon reconstruit alors une valeur simple, utilisable comme un littéral.
            for ident, types, _ in ctors:
                args = ", ".join(GO_CONV[t] % ("req.Args[%d]" % i) for i, t in enumerate(types))
                return_fields = ", ".join("moodit_cree.%s" % n for n, _ in field_list[typ])
                new_branch.append('        case "%s":\n'
                               '            moodit_cree := %s(%s)\n'
                               '            valeur = []interface{}{%s}'
                               % (ident, ident, args, return_fields))
        else:
            # On garde un POINTEUR vers l'objet : une méthode à récepteur pointeur — l'idiome le
            # plus répandu — ne peut pas être appelée sur le résultat d'une assertion de type,
            # qui n'est pas adressable. Le programme de l'étudiant ne compilait pas, et il lisait
            # « Échec de compilation » pour du code qu'il n'avait pas écrit.
            for ident, types, pointer in ctors:
                args = ", ".join(GO_CONV[t] % ("req.Args[%d]" % i) for i, t in enumerate(types))
                new_branch.append('        case "%s":\n'
                               '            moodit_cree := %s(%s)\n'
                               '            mooditObjets = append(mooditObjets, %smoodit_cree)\n'
                               '            valeur = len(mooditObjets) - 1'
                               % (ident, ident, args, "" if pointer else "&"))
        for ret, ident, types in method_list:
            args = ", ".join(GO_CONV[t] % ("req.Args[%d]" % i) for i, t in enumerate(types))
            # `(*T)` : un récepteur valeur s'appelle aussi sur un pointeur (déréférencement
            # automatique), donc une seule forme suffit pour les deux.
            method_branch.append('        case "%s.%s":\n'
                               '            valeur = mooditObjets[req.Handle].(*%s).%s(%s)'
                               % (typ, ident, typ, ident, args))
    return "\n".join(new_branch), "\n".join(method_branch)


def go_grader_source(methods, harness_code, nonce, obj_list=(), field_list=None):
    """Programme NOTEUR Go : bouchons typés + harnais booléen du prof + nonce. PURE (testée)."""
    stubs = []
    for ret, ident, types in methods:
        params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        # MÊME table que l'aiguillage et que les bouchons objets : trois copies divergentes ont
        # déjà produit trois défauts (deux contournements de l'encodage, une lecture en flottant).
        conv = GO_CONV[ret] % "v"
        stubs.append("""func %s(%s) %s {
    v := mooditAppel("%s", []interface{}{%s})
    return %s
}""" % (ident, params, ret, ident, args, conv))
    return go_alias_imports('''package main

import (
    "bufio"
    "crypto/rand"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "math"
    "os"
    "strings"
)

// `math` pour les tolerances flottantes du harnais (math.Abs(x - y) < 1e-9, l'idiome des
// questions a reponse flottante) ; marque comme utilise, Go refusant un import inutile. Sans
// risque de collision : les bouchons vivent au niveau du paquet, `math.X` sous son espace.
var _ = math.Abs
%s
var mooditLecteur = bufio.NewReader(os.Stdin)

// Identifiant IMPRÉVISIBLE par appel : sans lui, le code noté — dont le stdout EST le canal de
// réponse — pouvait imprimer la réponse attendue AVANT la question et faire passer un code faux.
func mooditId() string {
    b := make([]byte, 16)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func mooditNombre(v interface{}) float64 {
    if n, ok := v.(json.Number); ok {
        f, _ := n.Float64()
        return f
    }
    f, _ := v.(float64)
    return f
}

// Entier EXACT. Le JSON décodé dans un interface{} donne un float64, qui perd des unités
// au-delà de 2^53 : une factorielle ou une somme de grands nombres revenait fausse, et une
// réponse juste était notée fausse. Les nombres sont donc décodés en json.Number (UseNumber).
func mooditEntier(v interface{}) int64 {
    if n, ok := v.(json.Number); ok {
        i, err := n.Int64()
        if err == nil {
            return i
        }
        f, _ := n.Float64()
        return int64(f)
    }
    if f, ok := v.(float64); ok {
        return int64(f)
    }
    return 0
}

func mooditNouvelle(nom string, args []interface{}) interface{} {
    return mooditEnvoie(mooditReq{Op: "new", Name: nom, Args: args})
}

// Champs du résultat d'une fonction-constructeur exécutée CHEZ L'ÉTUDIANT : le bouchon les
// relit pour reconstruire une valeur simple, sans poignée ni champ caché.
func mooditChamps(nom string, args []interface{}) []interface{} {
    liste, _ := mooditNouvelle(nom, args).([]interface{})
    return liste
}

func mooditIndex(liste []interface{}, i int) interface{} {
    if i < len(liste) {
        return liste[i]
    }
    return float64(0)
}

func mooditMethode(handle int, nom string, args []interface{}) interface{} {
    return mooditEnvoie(mooditReq{Op: "method", Handle: handle, Name: nom, Args: args})
}

func mooditAppel(nom string, args []interface{}) interface{} {
    return mooditEnvoie(mooditReq{Op: "call", Name: nom, Args: args})
}

func mooditEnvoie(req mooditReq) interface{} {
    id := mooditId()
    req.Id = id
    // json.Marshal ECHOUE sur NaN et sur +/-Inf. L'erreur ignoree donnait une ligne VIDE, que
    // le decodeur d'en face rejette : les deux processus s'attendaient et le cas consommait tout
    // son temps limite pour rendre « Interrompu » au lieu d'un verdict.
    requete, errReq := json.Marshal(req)
    if errReq != nil {
        panic("valeur non representable transmise au code soumis")
    }
    fmt.Println(string(requete))
    for {
        ligne, err := mooditLecteur.ReadString('\\n')
        if err != nil {
            panic("processus etudiant termine")
        }
        var rep mooditRep
        // Le code noté partage ce flux : seule une réponse portant l'identifiant DE CET APPEL
        // compte. Tout le reste est du bruit, ou une tentative de devancer la question.
        dec := json.NewDecoder(strings.NewReader(ligne))
        dec.UseNumber()
        if dec.Decode(&rep) != nil || rep.Id != id {
            continue
        }
        if !rep.Ok {
            panic("appel refuse par le code soumis : " + rep.Error)
        }
        return rep.Value
    }
}

%s

%s

func mooditHarnais() bool {
%s
}

func main() {
    ok := false
    func() {
        defer func() {
            if r := recover(); r != nil {
                // fail-closed, mais jamais en silence : c'est le code du PROF qui a levé.
                // Texte relaye SANS saut de ligne : rep.Error est DECODE du JSON,
                // il peut donc contenir ce que le wire une-ligne ne portait pas.
                moodit_msg := []rune(fmt.Sprint(r))
                for i, c := range moodit_msg {
                    if c == 10 || c == 13 {
                        moodit_msg[i] = 32
                    }
                }
                fmt.Fprintln(os.Stderr, "[MOODIT] harnais:", string(moodit_msg))
                ok = false
            }
        }()
        ok = mooditHarnais()
    }()
    if ok {
        fmt.Fprintln(os.Stderr)
        fmt.Fprintln(os.Stderr, "%s")
    }
    if ok {
        os.Exit(0)
    }
    os.Exit(1)
}
''', GO_GRADER_ALIASED) % (GO_RPC_RUNTIME, "\n\n".join(stubs), go_object_stub(obj_list, field_list),
       "\n".join("    " + l if l.strip() else l for l in (harness_code or "").splitlines()),
       nonce)


def go_server_source(methods, obj_list=(), field_list=None):
    """Serveur de l'étudiant : aiguillage TYPÉ vers ses fonctions et ses objets. PURE (testée).

    Aucun nonce, aucun harnais, aucun attendu : ce programme ne peut rien apprendre du verdict."""
    new_branch, method_branch = go_object_dispatch(obj_list, field_list)
    branches = []
    for ret, ident, types in methods:
        # UNE seule table de conversion, partagée avec l'aiguillage des objets et les bouchons du
        # noteur : cette boucle-ci avait la sienne, et elle est restée sur `mooditNombre` quand
        # les entiers sont passés à la lecture exacte — une somme au-delà de 2^53 revenait fausse
        # sur le chemin le plus courant, celui de l'appel de fonction.
        args = ", ".join(GO_CONV[t] % ("req.Args[%d]" % i) for i, t in enumerate(types))
        branches.append('        case "%s":\n            valeur = %s(%s)' % (ident, ident, args))
    return go_alias_imports('''package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "os"
    "strings"
)
%s
func mooditNombre(v interface{}) float64 {
    if n, ok := v.(json.Number); ok {
        f, _ := n.Float64()
        return f
    }
    f, _ := v.(float64)
    return f
}

// Entier EXACT. Le JSON décodé dans un interface{} donne un float64, qui perd des unités
// au-delà de 2^53 : une factorielle ou une somme de grands nombres revenait fausse, et une
// réponse juste était notée fausse. Les nombres sont donc décodés en json.Number (UseNumber).
func mooditEntier(v interface{}) int64 {
    if n, ok := v.(json.Number); ok {
        i, err := n.Int64()
        if err == nil {
            return i
        }
        f, _ := n.Float64()
        return int64(f)
    }
    if f, ok := v.(float64); ok {
        return int64(f)
    }
    return 0
}

var mooditObjets []interface{}

func mooditServe() {
    lecteur := bufio.NewReader(os.Stdin)
    for {
        ligne, err := lecteur.ReadString('\\n')
        if err != nil {
            return
        }
        var req mooditReq
        dec := json.NewDecoder(strings.NewReader(ligne))
        dec.UseNumber()
        if dec.Decode(&req) != nil {
            continue
        }
        rep := mooditRep{Ok: true, Id: req.Id}
        func() {
            defer func() {
                if r := recover(); r != nil {
                    rep = mooditRep{Ok: false, Id: req.Id, Error: fmt.Sprint(r)}
                }
            }()
            var valeur interface{}
            if req.Op == "new" {
                switch req.Name {
%s
                default:
                    panic("constructeur inconnu : " + req.Name)
                }
            } else if req.Op == "method" {
                switch req.Name {
%s
                default:
                    panic("methode inconnue : " + req.Name)
                }
            } else {
                switch req.Name {
%s
                default:
                    panic("fonction inconnue : " + req.Name)
                }
            }
            rep.Value = valeur
        }()
        brut, errRep := json.Marshal(rep)
        if errRep != nil {
            // Meme motif que cote noteur : une valeur non representable (NaN, Inf) rendue par le
            // code soumis ne doit pas bloquer le couple, mais etre refusee explicitement.
            brut, _ = json.Marshal(mooditRep{Ok: false, Id: req.Id,
                Error: "valeur non representable en JSON"})
        }
        fmt.Print("\\n" + string(brut) + "\\n")
    }
}

func main() {
    mooditServe()
}
''', GO_SERVER_ALIASED) % (GO_RPC_RUNTIME, new_branch or "        case \"\":", method_branch or "        case \"\":",
       "\n".join(branches))


GO_MAIN_DECL = re.compile(r"^func\s+main\s*\(\s*\)\s*\{", re.M)


def go_student_without_main(source):
    """Code étudiant dont le `main` est renommé : le serveur généré fournit le point d'entrée.

    FONCTION PURE (testée). Même parade que le `#define main` du chemin C : on ne retire rien du
    code de l'étudiant, on le déplace."""
    return GO_MAIN_DECL.sub("func __moodit_student_main() {", source or "")


# ───────────────────── C / C++ : bouchon et aiguillage TYPÉS, protocole texte ─────────────────────
# Pas de bibliothèque JSON dans ces images : le protocole est une ligne « id|nom|arg|arg », la
# réponse « id|ok|valeur ». Chaque paire noteur/étudiant est du même langage, donc chacune peut
# avoir son protocole — seule compte la propriété : le harnais et le nonce ne sont PAS dans le
# binaire de l'étudiant, qui tourne sous un autre UID.

# Qualificatifs NON significatifs avant le type de retour (`static int f`, `inline`,
# `extern`, `const`) : sans eux, l ancre de debut de ligne ratait la signature, aucun
# bouchon n etait genere, et une reponse juste etait notee 0.
C_FUNC = re.compile(r"^[ \t]*(?:(?:static|inline|extern|const)\s+)*"
                    r"(int|long|double|float|char\s*\*)\s+(\w+)\s*\(([^()]*)\)\s*\{", re.M)
# `%.17g` et non `%g` : ce format est celui des ARGUMENTS comme des RETOURS, relus par atof.
# `%g` s'arrête à 6 chiffres significatifs — 3.14159265 arrivait tronqué chez l'étudiant et
# 1234567.89 revenait en notation exponentielle, donc une réponse JUSTE était notée fausse.
# 17 chiffres suffisent à garantir l'aller-retour exact d'un double IEEE 754.
C_TYPES = {"int": "%d", "long": "%ld", "double": "%.17g"}
# Lecture d'un champ texte, UNE seule fois pour les cinq sites qui en avaient une copie.
C_READ = {"int": "atoi", "long": "atol", "double": "atof"}


# Un littéral de caractère, et RIEN d'autre : 'x', '\n', '\u{1F600}'. Tout le reste —
# durée de vie Rust, étiquette de boucle, séparateur de chiffres C++ — est une apostrophe
# ordinaire, qui n'ouvre aucun littéral : la prendre pour une ouverture faisait ignorer les
# accolades jusqu'à la fin de la ligne et décalait le compteur pour tout le reste du fichier.
CHAR_LITERAL = re.compile(r"'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'")


def code_depths(source):
    """Profondeur d'accolades à chaque position, HORS chaînes et commentaires. PURE (testée).

    Sert à distinguer le PREMIER NIVEAU du reste : une `fn` indentée est une fonction associée
    d'un `impl` ou un helper imbriqué, pas une fonction libre. L'aiguillage généré l'appelait au
    niveau module, où le nom n'existe pas, et le programme de l'étudiant ne compilait plus.

    Un comptage naïf se faisait déséquilibrer par une accolade en LITTÉRAL (`c == '{'`, une
    chaîne de mise en forme, du JSON dans un commentaire) : toutes les fonctions suivantes
    passaient alors pour imbriquées et disparaissaient — un code correct rendait « aucune
    fonction exploitable ». Ce balayage est donc l'UNIQUE appariement d'accolades du fichier,
    partagé par les chemins Rust et C/C++, qui en avaient chacun une copie naïve.

    Règles couvertes : `//` jusqu'à la fin de ligne, `/* */` (imbriqués, comme en Rust), chaînes
    `"…"` et littéraux de caractère `'…'` avec échappements, chaînes brutes `r"…"` et `r#"…"#`
    (Rust) ou `R"(…)"` (C++)."""
    src_text = source or ""
    depths = [0] * len(src_text)
    level = 0
    i = 0
    n = len(src_text)
    block = 0            # profondeur des /* */
    while i < n:
        c = src_text[i]
        if block:
            if src_text.startswith("/*", i):
                block += 1
                depths[i] = level
                depths[i + 1] = level
                i += 2
                continue
            if src_text.startswith("*/", i):
                block -= 1
                depths[i] = level
                depths[i + 1] = level
                i += 2
                continue
            depths[i] = level
            i += 1
            continue
        if src_text.startswith("//", i):
            finish = src_text.find("\n", i)
            finish = n if finish < 0 else finish
            for j in range(i, finish):
                depths[j] = level
            i = finish
            continue
        if src_text.startswith("/*", i):
            block = 1
            depths[i] = level
            depths[i + 1] = level
            i += 2
            continue
        raw = re.match(r'r(#*)"', src_text[i:]) or re.match(r'R"\(', src_text[i:])
        if raw and (c in "rR"):
            if c == "r":
                hashes = raw.group(1)
                closed = '"' + hashes
                begin = i + 1 + len(hashes) + 1
            else:
                closed = ')"'
                begin = i + 3
            finish = src_text.find(closed, begin)
            finish = n if finish < 0 else finish + len(closed)
            for j in range(i, finish):
                depths[j] = level
            i = finish
            continue
        if c == "'" and not CHAR_LITERAL.match(src_text, i):
            # L'apostrophe n'ouvre PAS toujours un littéral de caractère : durée de vie Rust
            # (`&'static str`), étiquette de boucle (`'ext: loop`), séparateur de chiffres C++
            # (`1'000`). La prendre pour une ouverture faisait ignorer les accolades jusqu'à la
            # fin de la ligne, décalait le compteur pour tout le reste du fichier, et les
            # fonctions suivantes disparaissaient : un code CORRECT rendait « aucune fonction
            # exploitable ». On ne la traite comme un littéral que si elle en a la FORME.
            depths[i] = level
            i += 1
            continue
        if c in "\"'":
            depths[i] = level
            j = i + 1
            while j < n:
                if src_text[j] == "\\":
                    depths[j] = level
                    if j + 1 < n:
                        depths[j + 1] = level
                    j += 2
                    continue
                depths[j] = level
                if src_text[j] == c:
                    j += 1
                    break
                if src_text[j] == "\n":
                    break        # chaîne non fermée : on ne mange pas le reste du fichier
                j += 1
            i = j
            continue
        if c == "}":
            level -= 1
        depths[i] = level
        if c == "{":
            level += 1
        i += 1
    return depths


def block_end(src_text, begin):
    """Fin du bloc ouvert à `debut` (index de son `{`), par appariement LEXICAL. PURE (testée).

    Même balayage que `code_depths` — une accolade en littéral ou en commentaire ne compte pas —
    au lieu des trois copies naïves qu'en avaient les chemins Rust et C++.

    Les profondeurs sont calculées UNE fois par texte (_fermetures) : recalculées à chaque
    classe, 400 classes C++ prenaient 44 s par cas, hors de tout budget. Même résultat : la
    première accolade fermante après `debut` à la même profondeur, trouvée par dichotomie."""
    depths, by_level = _closings(src_text)
    entries = by_level.get(depths[begin], [])
    k = bisect.bisect_right(entries, begin)
    return entries[k] if k < len(entries) else len(src_text)


@functools.lru_cache(maxsize=8)
def _closings(src_text):
    """Profondeurs du texte et, par profondeur, positions de ses `}` de CODE. Mémoïsé."""
    depths = code_depths(src_text)
    by_level = {}
    for i, c in enumerate(src_text):
        if c == "}":
            by_level.setdefault(depths[i], []).append(i)
    return depths, by_level


def cpp_class_spans(source):
    """Plages (début, fin) des corps de classe/structure C++. FONCTION PURE (testée).

    Sert à ne PAS prendre une méthode pour une fonction libre : `int aire() { … }` indenté dans
    une classe n'est pas appelable sans objet, et le bouchon généré ne compilait pas."""
    src_text = source or ""
    spans = []
    for klass in CPP_CLASS.finditer(src_text):
        try:
            begin = src_text.index("{", klass.start())
        except ValueError:
            continue
        spans.append((begin, block_end(src_text, begin)))
    return spans


def c_signatures(source, cpp=False):
    """Fonctions de premier niveau du code étudiant → [(retour, nom, [types])]. PURE (testée).

    Seuls int/long/double sont marshalés dans ce jalon ; `main` est écartée, ainsi que — en C++ —
    tout ce qui vit dans un corps de classe (ce sont des méthodes, proxifiées par poignée). Une
    signature hors liste n'est pas proxifiée : le harnais qui l'appelle ne compilera pas (message
    au prof, jamais un faux verdict)."""
    spans = cpp_class_spans(source) if cpp else []
    hits = []
    for hit in C_FUNC.finditer(source or ""):
        if any(begin <= hit.start() <= finish for begin, finish in spans):
            continue
        ret, ident, params = hit.group(1), hit.group(2), hit.group(3)
        ret = ret.replace(" ", "")
        if ident == "main" or ret not in C_TYPES:
            continue
        # Le MEME lecteur que le chemin objet C++ (_c_param_types) : deux copies divergeaient.
        types = _c_param_types(params)
        if types is None:
            continue
        hits.append((ret, ident, types))
    return hits


CPP_QUALIF = re.compile(r"^(?:(?:explicit|virtual|inline|constexpr)\s+)+")
CPP_CLASS = re.compile(r"^[ \t]*(?:class|struct)\s+(\w+)", re.M)


def cpp_object_api(source):
    """API OBJET C++ → [(classe, [constructeurs], [(retour, méthode, [types])])]. PURE (testée).

    Le corps de la classe est découpé par appariement d'accolades, et seules les déclarations de
    la section PUBLIQUE comptent (une `class` commence en privé, une `struct` en public)."""
    src_text = source or ""
    result = []
    spans = cpp_class_spans(src_text)
    for klass in CPP_CLASS.finditer(src_text):
        class_ident = klass.group(1)
        # Classe IMBRIQUEE : elle ne s'ecrit que `A::B`, et le serveur, qui la nomme `B`, ne
        # compilait plus. Elle n'est pas proxifiee (ni ses membres pris pour ceux de A).
        if any(d < klass.start() < f for d, f in spans):
            continue
        try:
            begin = src_text.index("{", klass.start())
        except ValueError:
            continue
        finish = block_end(src_text, begin)
        body = src_text[begin + 1:finish]
        public = src_text[klass.start():begin].lstrip().startswith("struct")
        ctors, method_list = [], []
        depths = _closings(src_text)[0]
        level = depths[begin] + 1
        position = begin + 1
        for src_line in _member_pieces(body, begin + 1, depths, level):
            line_begin = position + len(src_line) - len(src_line.lstrip())
            position += len(src_line)
            # Une ligne d'une classe IMBRIQUEE n'est pas un membre de celle-ci : ses methodes
            # etaient attribuees a la classe englobante, et le serveur ne compilait plus.
            if line_begin < len(src_text) and depths[line_begin] != level:
                continue
            bare_line = src_line.strip()
            if bare_line.startswith("public:"):
                public = True
                bare_line = bare_line[len("public:"):].strip()
            elif bare_line.startswith("private:") or bare_line.startswith("protected:"):
                public = False
                continue
            if not public or not bare_line:
                continue
            # Qualificatifs sans effet sur la signature vue de l'appelant.
            bare_line = CPP_QUALIF.sub("", bare_line)
            ctor = re.match(re.escape(class_ident) + r"\s*\(([^()]*)\)", bare_line)
            if ctor:
                types = _c_param_types(ctor.group(1))
                if types is not None:
                    ctors.append(types)
                continue
            meth = re.match(r"(int|long|double)\s+(\w+)\s*\(([^()]*)\)", bare_line)
            if meth:
                types = _c_param_types(meth.group(3))
                if types is not None:
                    method_list.append((meth.group(1), meth.group(2), types))
        if ctors and method_list:
            result.append((class_ident, ctors, method_list))
    return result


def _member_pieces(body, offset, depths, level):
    """Corps de classe découpé en morceaux d'au plus UN membre chacun. FONCTION PURE (testée).

    Coupe aux fins de ligne ET après chaque `;` ou `}` du niveau de la classe : sans cela, deux
    membres sur une même ligne (`Rect(int w):w(w) {} int aire() {…}`) n'étaient vus que par le
    premier, le constructeur faisait sauter la ligne, la méthode n'était pas proxifiée et une
    réponse juste notait 0. `offset` est la position de `body` dans le source, `depths` vient de
    code_depths (une `}` porte la profondeur APRÈS sa fermeture). Les morceaux, mis bout à bout,
    redonnent `body`."""
    pieces = []
    start = 0
    for i, c in enumerate(body):
        cut = c == chr(10) or (c in ";}" and depths[offset + i] == level)
        if cut:
            pieces.append(body[start:i + 1])
            start = i + 1
    if start < len(body):
        pieces.append(body[start:])
    return pieces


def _c_param_types(params):
    """Types des parametres d'une signature C/C++, ou None si l'un n'est pas marshalable. PURE.

    SEUL lecteur de parametres C/C++, pour les fonctions libres comme pour le chemin objet : deux
    copies divergeaient (les pointeurs etaient ecartes dans l'une, pris pour un scalaire dans
    l'autre). Pointeur, tableau ou reference -> None (pas de bouchon : `int *tab` n'est pas
    `int`). `const` est ignore : `const int n` est un `int` pour l'appelant."""
    types = []
    for param_group in [p.strip() for p in params.split(",") if p.strip() and p.strip() != "void"]:
        if any(c in param_group for c in "*[&"):
            return None
        pieces = [m for m in param_group.split() if m != "const"]
        if len(pieces) < 2 or pieces[0] not in C_TYPES:
            return None
        types.append(pieces[0])
    return types


def cpp_object_stub(obj_list):
    """Bouchons OBJET C++ : classe à poignée, constructeurs et méthodes relayés. PURE (testée)."""
    pieces = []
    for klass, ctors, method_list in obj_list:
        body = ["class %s {" % klass, "    int __h;", "public:"]
        for types in ctors:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            fmt = "".join("|" + C_TYPES[t] for t in types)
            args = "".join(", a%d" % i for i in range(len(types)))
            body += ["    %s(%s) {" % (klass, params),
                      "        char id[40], requete[4096];",
                      "        moodit_identifiant(id);",
                      '        snprintf(requete, sizeof requete, "%%s|new|%s%s", id%s);'
                      % (c_dispatch_key(klass, types), fmt, args),
                      "        moodit_envoie(requete);",
                      "        __h = atoi(moodit_valeur(id));",
                      "    }"]
        for ret, ident, types in method_list:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            fmt = "".join("|" + C_TYPES[t] for t in types)
            args = "".join(", a%d" % i for i in range(len(types)))
            reader = C_READ[ret]
            body += ["    %s %s(%s) {" % (ret, ident, params),
                      "        char id[40], requete[4096];",
                      "        moodit_identifiant(id);",
                      '        snprintf(requete, sizeof requete, "%%s|method|%s.%s|%%d%s", id, __h%s);'
                      % (klass, c_dispatch_key(ident, types), fmt, args),
                      "        moodit_envoie(requete);",
                      "        return %s(moodit_valeur(id));" % reader,
                      "    }"]
        body.append("};")
        pieces.append("\n".join(body))
    return "\n\n".join(pieces)


def c_dispatch_key(ident, types):
    """Cle d'aiguillage C/C++ : NOM ET TYPES, `Rect(int,int)`. PURE (testee).

    Le seul nom ne choisit pas une surcharge : avec `Rect()` declare avant `Rect(int, int)`,
    c'est `Rect()` qui etait construit, et une reponse juste etait notee fausse. L'arite seule
    ne departagerait pas `f(int)` de `f(double)`."""
    return "%s(%s)" % (ident, ",".join(types))


def cpp_object_dispatch(obj_list):
    """Aiguillage OBJET côté étudiant : une pile PAR CLASSE, construction réelle. PURE (testée)."""
    stacks, branches = [], []
    for klass, ctors, method_list in obj_list:
        stacks.append("static std::vector<%s> moodit_objets_%s;" % (klass, klass))
        for types in ctors:
            reads = "\n".join(
                "        %s a%d = %s(moodit_jeton());"
                % (t, i, C_READ[t])
                for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            branches.append('''    if (strcmp(op, "new") == 0 && strcmp(nom, "%s") == 0) {
%s
        moodit_objets_%s.push_back(%s(%s));
        printf("\\n%%s|ok|%%d\\n", id, (int) moodit_objets_%s.size() - 1);
        fflush(stdout);
        return;
    }''' % (c_dispatch_key(klass, types), reads, klass, klass, args, klass))
        for ret, ident, types in method_list:
            reads = "\n".join(
                "        %s a%d = %s(moodit_jeton());"
                % (t, i, C_READ[t])
                for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            branches.append('''    if (strcmp(op, "method") == 0 && strcmp(nom, "%s.%s") == 0) {
        int h = atoi(moodit_jeton());
%s
        printf("\\n%%s|ok|%s\\n", id, moodit_objets_%s[h].%s(%s));
        fflush(stdout);
        return;
    }''' % (klass, c_dispatch_key(ident, types), reads, C_TYPES[ret], klass, ident, args))
    return "\n".join(stacks), "\n\n".join(branches)


C_RUNTIME = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char moodit_ligne[8192];

static void moodit_envoie(const char *requete) {
    fputs(requete, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

/* Lit la reponse PORTANT L'IDENTIFIANT demande ; tout le reste est du bruit (ou une tentative
   de devancer la question, le stdout du code note etant le canal de reponse). */
static const char *moodit_attend(const char *id) {
    while (fgets(moodit_ligne, sizeof moodit_ligne, stdin)) {
        char *sep = strchr(moodit_ligne, '|');
        if (!sep) { continue; }
        *sep = '\0';
        if (strcmp(moodit_ligne, id) != 0) { continue; }
        return sep + 1;
    }
    return NULL;
}

/* Valeur de la reponse, ou arret net : factorise ce que chaque bouchon faisait a la main. */
static const char *moodit_valeur(const char *id) {
    const char *reponse = moodit_attend(id);
    if (!reponse || strncmp(reponse, "ok|", 3) != 0) {
        fprintf(stderr, "[MOODIT] appel refuse par le code soumis\n");
        exit(3);
    }
    return reponse + 3;
}

'''


C_GRADER_HEADER = "#include <math.h>\n#include <stdbool.h>\n"


def c_probe_source(names):
    """Sonde des noms RESERVES du noteur C/C++. FONCTION PURE (testée).

    Reprend exactement les en-tetes que voit le harnais (C_GRADER_HEADER, puis ceux de
    C_RUNTIME) et declare chaque nom comme une VARIABLE : la sonde compile si et seulement si
    aucun de ces en-tetes ne declare deja ce nom (fonction, surcharge C++ ou mot-cle), et le
    #ifdef attrape les macros (`isnan`, `true` en C), qu'une variable ne heurterait pas."""
    includes = "".join(l + "\n" for l in C_RUNTIME.splitlines() if l.startswith("#include"))
    checks = "".join("#ifdef %s\n#error moodit_reserve\n#endif\nint %s;\n" % (n, n) for n in names)
    return C_GRADER_HEADER + includes + checks


# Identifiants RESERVES A L'IMPLEMENTATION (C17 7.1.3, C++ [lex.name]) : tout nom qui commence
# par `_` suivi d'une majuscule, et tout nom qui contient `__` (en C, seulement en tete ; on
# applique la regle C++, plus large, aux deux langages). Les macros des en-tetes s'y developpent
# (`HUGE_VAL` -> `__builtin_huge_val ()`, `isnan` -> `__builtin_isnan`…) : une fonction soumise de
# ce nom, renommee par #define dans le noteur, detournait ces outils vers le code note. La sonde
# ne les voit pas, et la signature peut meme venir d'un bloc `#if 0` (lecture du texte brut).
C_IMPL_RESERVED = re.compile(r"^_[A-Z]|__")


def c_implementation_reserved(names):
    """Noms reserves a l'implementation C/C++ parmi `names`. FONCTION PURE (testee)."""
    return [n for n in dict.fromkeys(names) if C_IMPL_RESERVED.search(n)]


def c_reserved_names(names, compiler, std, case_dir, env):
    """Noms de `names` reserves a l'implementation, ou deja declares par les en-tetes du noteur
    (sonde -fsyntax-only, root).

    Une seule compilation dans le cas courant (aucun nom reserve) ; en cas d'echec, une sonde
    par nom pour nommer les fautifs dans le message."""
    names = list(dict.fromkeys(names))
    impl = c_implementation_reserved(names)
    names = [n for n in names if n not in impl]
    probe = os.path.join(case_dir, "sonde.c" if compiler == "gcc" else "sonde.cpp")

    def compiles(subset):
        write_private(probe, c_probe_source(subset))
        code, expired = run_proc([compiler, std, "-fno-builtin", "-fsyntax-only", probe],
                                 case_dir, env, COMPILE_TIMEOUT_S,
                                 os.path.join(case_dir, "sonde.out"),
                                 os.path.join(case_dir, "sonde.err"), preexec_compile)
        return code == 0 and not expired

    if not names or compiles(names):
        return impl
    return impl + [n for n in names if not compiles([n])]


def reserved_name_message(names, origin):
    """Message de refus d'une soumission qui reutilise un nom fourni au harnais. PURE (testée)."""
    return ("Nom de fonction réservé : %s %s déjà fourni%s au harnais par %s. Le harnais ne "
            "pourrait pas distinguer votre fonction de celle-ci ; renommez-la."
            % (", ".join("« %s »" % n for n in names), "est" if len(names) == 1 else "sont",
               "" if len(names) == 1 else "s", origin))


def c_grader_source(methods, harness_code, nonce, cpp=False, obj_list=()):
    """Programme NOTEUR C/C++ : bouchons typés + harnais booléen + nonce. PURE (testée)."""
    stubs = []
    for ret, ident, types in methods:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        fmt = "".join("|" + C_TYPES[t] for t in types)
        args = "".join(", a%d" % i for i in range(len(types)))
        reader = C_READ[ret]
        # Prefixe moodit_f_ : le bouchon ne heurte aucune declaration des en-tetes (les noms
        # qu'ils declarent sont de toute facon refuses en amont, voir c_reserved_names).
        stubs.append("""%s moodit_f_%s(%s) {
    char id[40], requete[4096];
    moodit_identifiant(id);
    snprintf(requete, sizeof requete, "%%s|call|%s%s", id%s);
    moodit_envoie(requete);
    return %s(moodit_valeur(id));
}""" % (ret, ident, params or "void", c_dispatch_key(ident, types), fmt, args, reader))
    # Le harnais du prof ne peut pas ajouter d'#include : <math.h> (fabs, sqrt) et <stdbool.h>
    # (true/false en C) lui sont fournis. Les bouchons sont PREFIXES puis renommes par #define.
    # Aucun nom deja declare par ces en-tetes n'arrive jusqu'ici : run_c_rpc refuse avant
    # (c_reserved_names). Sinon le #define detournait vers le code note les `fabs`, `sqrt`,
    # `isnan`… que le harnais utilise comme OUTILS, et une `fabs` soumise qui renvoie 0
    # faisait passer `fabs(f(x) - attendu) < 1e-9` quel que soit f.
    header = C_GRADER_HEADER
    renames = "".join("#define %s moodit_f_%s\n" % (n, n)
                         for n in dict.fromkeys(ident for _, ident, _ in methods))
    return header + C_RUNTIME + r'''
/* Identifiant IMPREVISIBLE par appel, tire de /dev/urandom : sans lui, le code note pouvait
   imprimer la reponse attendue AVANT la question et faire passer un code faux. */
static void moodit_identifiant(char *sortie) {
    unsigned char brut[8];
    FILE *alea = fopen("/dev/urandom", "rb");
    if (!alea || fread(brut, 1, sizeof brut, alea) != sizeof brut) {
        fprintf(stderr, "[MOODIT] alea indisponible\n");
        exit(4);
    }
    fclose(alea);
    for (int i = 0; i < 8; i++) { sprintf(sortie + i * 2, "%02x", brut[i]); }
    sortie[16] = '\0';
}

''' + "\n\n".join(stubs) + "\n\n" + renames + cpp_object_stub(obj_list) + r'''

static int moodit_harnais(void) {
''' + "\n".join("    " + l if l.strip() else l
                for l in (harness_code or "").splitlines()) + r'''
}

int main(void) {
    if (moodit_harnais()) {
        fputc(10, stderr);
        fputs("''' + nonce + r'''", stderr);
        fputc(10, stderr);
        fflush(stderr);
        return 0;
    }
    return 1;
}
'''


def c_server_source(methods, student_source, cpp=False, obj_list=()):
    """Programme ÉTUDIANT C/C++ : son code (main renommé) + aiguillage typé. PURE (testée)."""
    branches = []
    for ret, ident, types in methods:
        reads = []
        for i, t in enumerate(types):
            conv = C_READ[t]
            reads.append("        %s a%d = %s(moodit_jeton());" % (t, i, conv))
        args = ", ".join("a%d" % i for i in range(len(types)))
        branches.append("""    if (strcmp(op, "call") == 0 && strcmp(nom, "%s") == 0) {
%s
        printf("\\n%%s|ok|%s\\n", id, %s(%s));
        fflush(stdout);
        return;
    }""" % (c_dispatch_key(ident, types), "\n".join(reads), C_TYPES[ret], ident, args))
    stacks, object_branches = cpp_object_dispatch(obj_list)
    return ("#define main __moodit_student_main\n"
            + (student_source or "")
            + "\n#undef main\n"
            + ("#include <vector>\n" if obj_list else "")
            + C_RUNTIME + stacks + r'''
static char *moodit_reste;

/* Decoupage a la main : strsep n'est pas dans l'ISO C17 (-std=c17), et ceci compile aussi en C++. */
static const char *moodit_jeton(void) {
    if (!moodit_reste) { return "0"; }
    char *debut = moodit_reste;
    char *sep = strchr(debut, '|');
    if (sep) { *sep = '\0'; moodit_reste = sep + 1; } else { moodit_reste = NULL; }
    return debut;
}

/* Protocole : id|op|nom|[poignée]|args… — `op` vaut call, new ou method. */
static void moodit_traite(const char *id, const char *op, const char *nom) {
''' + "\n".join(branches) + "\n\n" + object_branches + r'''
    printf("\n%s|err|fonction inconnue\n", id);
    fflush(stdout);
}

int main(void) {
    while (fgets(moodit_ligne, sizeof moodit_ligne, stdin)) {
        char *fin = strchr(moodit_ligne, '\n');
        if (fin) { *fin = '\0'; }
        moodit_reste = moodit_ligne;
        const char *id = moodit_jeton();
        const char *op = moodit_jeton();
        const char *nom = moodit_jeton();
        moodit_traite(id, op, nom);
    }
    return 0;
}
''')


# ─────────────────── Rust : bouchon et aiguillage TYPÉS, protocole texte ───────────────────
# Pas de serde dans l'image (aucun réseau à la compilation) : même protocole texte que C.

RUST_FN = re.compile(r"^[ \t]*(?:pub\s+)?fn\s+(\w+)\s*\(([^()]*)\)\s*->\s*([\w:]+)", re.M)
RUST_TYPES = {"i32": "i32", "i64": "i64", "f64": "f64", "bool": "bool", "String": "String"}


def rust_signatures(source):
    """Fonctions de PREMIER NIVEAU du code étudiant → [(retour, nom, [types])]. PURE (testée)."""
    depths = code_depths(source)
    hits = []
    for hit in RUST_FN.finditer(source or ""):
        ident, params, ret = hit.group(1), hit.group(2), hit.group(3)
        if depths[hit.start(1)] != 0:
            continue    # fonction associée (impl) ou imbriquée : pas appelable au niveau module
        if ident == "main" or ret not in RUST_TYPES:
            continue
        types = []
        valid = True
        for param_group in [p.strip() for p in params.split(",") if p.strip()]:
            if ":" not in param_group:
                valid = False
                break
            t = param_group.split(":", 1)[1].strip()
            if t not in RUST_TYPES:
                valid = False
                break
            types.append(t)
        if valid:
            hits.append((ret, ident, types))
    return hits


RUST_STRUCT = re.compile(r"^[ \t]*(?:pub\s+)?struct\s+(\w+)", re.M)
RUST_IMPL = re.compile(r"^[ \t]*impl\s+(\w+)\s*\{", re.M)
RUST_FN_IN_IMPL = re.compile(
    r"^[ \t]*(?:pub\s+)?fn\s+(\w+)\s*\(([^()]*)\)\s*->\s*([\w:]+)", re.M)
def rust_send_args(types):
    """Serialisation des arguments Rust sur le fil. FONCTION PURE (testee).

    Une chaine part en HEXADECIMAL : le protocole est a champs separes par « | » et a une ligne
    par message, donc un « | » ou un saut de ligne dans la valeur decalait tout l'appel, et une
    reponse JUSTE etait notee fausse."""
    return "".join(
        ' + "|" + &moodit_hexe(&a%d)' % i if t == "String" else ' + "|" + &a%d.to_string()' % i
        for i, t in enumerate(types))


RUST_CONV = {"i32": "%s.parse::<i32>().unwrap_or_default()",
             "i64": "%s.parse::<i64>().unwrap_or_default()",
             "f64": "%s.parse::<f64>().unwrap_or_default()",
             "bool": "%s.parse::<bool>().unwrap_or_default()",
             "String": "moodit_dehexe(%s)"}


def rust_object_api(source):
    """API OBJET Rust → [(type, [(ctor, [types])], [(retour, méthode, [types])])]. PURE (testée).

    Un `impl` est découpé par appariement d'accolades : une fonction associée qui RENVOIE le type
    est un constructeur (`Rectangle::new`), une fonction qui prend `&self` est une méthode."""
    src_text = source or ""
    structs = set(RUST_STRUCT.findall(src_text))
    by_type = {}                           # type -> (ctors, methodes), ordre d'apparition
    captured = rust_capture_fields(src_text)   # UNE fois : relu dans la boucle, c'etait quadratique
    for impl in RUST_IMPL.finditer(src_text):
        typ = impl.group(1)
        if typ not in structs:
            continue
        begin = src_text.index("{", impl.start())
        finish = block_end(src_text, begin)
        body = src_text[begin:finish]
        # Plusieurs blocs `impl` pour le meme type se CUMULENT : le constructeur d'un premier
        # bloc etait perdu quand les methodes venaient d'un second.
        ctors, method_list = by_type.setdefault(typ, ([], []))
        for ident, params, ret in RUST_FN_IN_IMPL.findall(body):
            pieces = [p.strip() for p in params.split(",") if p.strip()]
            takes_self = bool(pieces) and pieces[0].endswith("self")
            # Seul un EMPRUNT (`&self`, `&mut self`, `&'a self`) se proxifie : le serveur
            # appelle la méthode sur l'objet resté dans sa table (`moodit_t[h].f()`), qu'il ne
            # peut pas déplacer. Une méthode qui CONSOMME `self` (`fn en_texte(self)`) faisait
            # refuser tout le serveur par rustc (E0507), même si le harnais ne l'appelait pas.
            if takes_self and not pieces[0].replace(" ", "").startswith("&"):
                continue
            useful = pieces[1:] if takes_self else pieces
            types = []
            valid = True
            for param_group in useful:
                if ":" not in param_group or param_group.split(":", 1)[1].strip() not in RUST_TYPES:
                    valid = False
                    break
                types.append(param_group.split(":", 1)[1].strip())
            if not valid:
                continue
            # `-> Self` est la forme du Rust Book : c'est le meme constructeur que `-> Type`.
            if not takes_self and ret in (typ, "Self"):
                ctors.append((ident, types))
            elif takes_self and ret in RUST_TYPES:
                method_list.append((ret, ident, types))
    result = []
    for typ, (ctors, method_list) in by_type.items():
        if method_list and (ctors or typ in captured):
            result.append((typ, ctors, dedupe_signatures(method_list)))
    return result


RUST_STRUCT_BODY = re.compile(r"^[ \t]*(?:pub\s+)?struct\s+(\w+)\s*\{([^{}]*)\}", re.M | re.S)


def rust_struct_fields(source):
    """Champs des structures du code étudiant → {type: [(champ, type)]}. PURE (testée).

    Comme en Go, l'idiome Rust d'une structure sans `new` est le LITTÉRAL À CHAMPS NOMMÉS
    (`Rectangle { largeur: 3, hauteur: 4 }`) : c'est la forme qu'écrivent les profs, donc celle
    qu'il faut savoir proxifier."""
    field_list = {}
    for typ, body in RUST_STRUCT_BODY.findall(source or ""):
        entries = []
        for param_group in body.split(","):
            bare_line = param_group.split("//")[0].strip()
            if not bare_line:
                continue
            if ":" not in bare_line:
                entries = None
                break
            ident, type_ = (m.strip() for m in bare_line.split(":", 1))
            # `pub largeur: i32` (et `pub(crate) ...`) : la visibilite ne fait pas partie du nom —
            # sans ce retrait, « pub largeur » etait refuse et la structure entiere perdue.
            ident = re.sub(r"^pub(\([^)]*\))?\s+", "", ident)
            if type_ not in RUST_TYPES or not ident.isidentifier():
                entries = None
                break
            entries.append((ident, type_))
        if entries:
            field_list[typ] = entries
    return field_list


def rust_mut_receivers(source):
    """Types dont au moins une méthode prend `&mut self`. FONCTION PURE (testée).

    Pendant exact de `go_pointer_receivers` : une telle méthode peut modifier l'objet, et la
    capture de champs le reconstruit à chaque appel — la modification serait perdue EN SILENCE,
    donc un verdict faux sans diagnostic. Ces types passent par la poignée d'un constructeur."""
    src_text = source or ""
    mutants = set()
    for impl in RUST_IMPL.finditer(src_text):
        typ = impl.group(1)
        try:
            begin = src_text.index("{", impl.start())
        except ValueError:
            continue
        finish = block_end(src_text, begin)
        for _, params, _ in RUST_FN_IN_IMPL.findall(src_text[begin:finish]):
            first_item = (params.split(",")[0] if params else "").strip()
            if first_item.replace(" ", "").startswith("&mutself"):
                mutants.add(typ)
    return mutants


def rust_capture_fields(source):
    """Champs CAPTURABLES : ceux des structures sans méthode `&mut self`. PURE (testée).

    Décision prise ICI et nulle part ailleurs, comme `go_capture_fields` : bouchon, aiguillage et
    lecture d'API doivent s'accorder."""
    mutants = rust_mut_receivers(source)
    return {t: f for t, f in rust_struct_fields(source).items() if t not in mutants}


def rust_object_stub(obj_list, field_list=None):
    """Bouchons OBJET Rust : littéral à champs capturés ou poignée, et méthodes relayées.

    FONCTION PURE (testée). Champs tous marshalables → le bouchon les MIROITE et la méthode
    construit l'objet CHEZ l'étudiant au moment de l'appel ; sinon, poignée d'un constructeur."""
    field_list = field_list or {}
    pieces = []
    for typ, ctors, method_list in obj_list:
        if typ in field_list:
            declaration = "struct %s {\n%s\n}" % (
                typ, "\n".join("    %s: %s," % (n, t) for n, t in field_list[typ]))
            # Les champs suivent la MÊME sérialisation que les arguments : le lecteur d'en face
            # déhexe, donc un champ String envoyé en clair revenait mutilé (une valeur commençant
            # par « H » surtout), et une réponse juste était notée fausse.
            send_fields = "".join(
                ' + "|" + &moodit_hexe(&self.%s)' % n if t == "String"
                else ' + "|" + &self.%s.to_string()' % n
                for n, t in field_list[typ])
            body = []
            # Une fonction associée CONSTRUCTRICE (Rectangle::new) reste proxifiée : elle
            # s'exécute chez l'étudiant et le bouchon relit les champs de son résultat.
            for ident, types in ctors:
                params = ", ".join("a%d: %s" % (i, t) for i, t in enumerate(types))
                send_args = rust_send_args(types)
                reads = "\n".join(
                    "        let %s = %s;" % (n, RUST_CONV[t] % 'parts.next().unwrap_or("")')
                    for n, t in field_list[typ])
                literal = ", ".join(n for n, _ in field_list[typ])
                body.append('''    fn %s(%s) -> %s {
        let id = moodit_id();
        let brut = moodit_appel(&id, &(id.clone() + "|new|%s::%s"%s));
        let mut parts = brut.split('|');
%s
        %s { %s }
    }''' % (ident, params, typ, typ, ident, send_args, reads, typ, literal))
            for ret, ident, types in method_list:
                params = ", ".join(["&self"] + ["a%d: %s" % (i, t) for i, t in enumerate(types)])
                send_args = rust_send_args(types)
                parse = ("moodit_dehexe(brut.as_str())" if ret == "String"
                         else "brut.parse::<%s>().unwrap_or_default()" % ret)
                body.append('''    fn %s(%s) -> %s {
        let cid = moodit_id();
        let h = moodit_appel(&cid, &(cid.clone() + "|new|%s"%s));
        let id = moodit_id();
        let requete = id.clone() + "|method|%s.%s|" + &h%s;
        let brut = moodit_appel(&id, &requete);
        %s
    }''' % (ident, params, ret, typ, send_fields, typ, ident, send_args, parse))
            pieces.append("%s\n\nimpl %s {\n%s\n}"
                            % (declaration, typ, "\n\n".join(body)))
            continue
        body = []
        for ident, types in ctors:
            params = ", ".join("a%d: %s" % (i, t) for i, t in enumerate(types))
            send_args = rust_send_args(types)
            body.append('''    fn %s(%s) -> %s {
        let id = moodit_id();
        let requete = id.clone() + "|new|%s::%s"%s;
        %s { __h: moodit_appel(&id, &requete).parse::<i64>().unwrap_or_default() }
    }''' % (ident, params, typ, typ, ident, send_args, typ))
        for ret, ident, types in method_list:
            params = ", ".join(["&self"] + ["a%d: %s" % (i, t) for i, t in enumerate(types)])
            send_args = rust_send_args(types)
            parse = ("moodit_dehexe(brut.as_str())" if ret == "String"
                     else "brut.parse::<%s>().unwrap_or_default()" % ret)
            # Ordre du protocole, commun à tous les langages à protocole texte :
            #   id|op|nom|poignée|args…   (la poignée ne vaut que pour `method`)
            body.append('''    fn %s(%s) -> %s {
        let id = moodit_id();
        let requete = id.clone() + "|method|%s.%s|" + &self.__h.to_string()%s;
        let brut = moodit_appel(&id, &requete);
        %s
    }''' % (ident, params, ret, typ, ident, send_args, parse))
        pieces.append("struct %s {\n    __h: i64,\n}\n\nimpl %s {\n%s\n}"
                        % (typ, typ, "\n\n".join(body)))
    return "\n\n".join(pieces)


def rust_object_dispatch(obj_list, field_list=None):
    """Aiguillage OBJET côté étudiant : une pile PAR TYPE, pas d'unsafe. PURE (testée).

    Un type à champs capturés se construit par son littéral, comme l'écrirait l'étudiant ; la clé
    `new` porte alors le NOM DU TYPE et non celui d'un constructeur. Une fonction constructrice a
    pour clé `new|Type::fonction` : avec le seul nom de la fonction, deux types dotés chacun d'un
    `fn new` partageaient le bras `"new|new"`, et le second construisait un objet du premier."""
    field_list = field_list or {}
    stacks, branches = [], []
    for typ, ctors, method_list in obj_list:
        stacks.append("    let mut moodit_%s: Vec<%s> = Vec::new();" % (typ.lower(), typ))
        if typ in field_list:
            reads = "\n".join(
                '                let %s = %s;' % (n, RUST_CONV[t] % 'args.next().unwrap_or("")')
                for n, t in field_list[typ])
            literal = "%s { %s }" % (typ, ", ".join(n for n, _ in field_list[typ]))
            branches.append('''            "new|%s" => {
%s
                moodit_%s.push(%s);
                format!("{}|ok|{}", id, moodit_%s.len() - 1)
            }''' % (typ, reads, typ.lower(), literal, typ.lower()))
            for ident, types in ctors:
                read_args = "\n".join(
                    '                let a%d = %s;'
                    % (i, RUST_CONV[t] % 'args.next().unwrap_or("")')
                    for i, t in enumerate(types))
                call_expr = "%s::%s(%s)" % (typ, ident, ", ".join("a%d" % i for i in range(len(types))))
                rets = "".join(
                    '                                + "|" + &moodit_hexe(&moodit_cree.%s)' % n
                    if t == "String"
                    else '                                + "|" + &moodit_cree.%s.to_string()' % n
                    for n, t in field_list[typ])
                branches.append('''            "new|%s::%s" => {
%s
                let moodit_cree = %s;
                format!("{}|ok", id)
%s
            }''' % (typ, ident, read_args, call_expr, rets))
        else:
            # Sans capture de champs, le constructeur rend une POIGNÉE. Les deux formes étaient
            # émises pour un type à champs capturés : le second bras, inatteignable, valait un
            # avertissement `unreachable_patterns` à la compilation.
            for ident, types in ctors:
                reads = "\n".join(
                    '                let a%d = %s;'
                    % (i, RUST_CONV[t] % 'args.next().unwrap_or("")')
                    for i, t in enumerate(types))
                call_expr = "%s::%s(%s)" % (typ, ident,
                                        ", ".join("a%d" % i for i in range(len(types))))
                branches.append('''            "new|%s::%s" => {
%s
                moodit_%s.push(%s);
                format!("{}|ok|{}", id, moodit_%s.len() - 1)
            }''' % (typ, ident, reads, typ.lower(), call_expr, typ.lower()))
        for ret, ident, types in method_list:
            # Les arguments de la méthode doivent être LUS et TRANSMIS : sans cela, le bouchon du
            # noteur les envoyait, l'appel généré ici était à vide, et rustc refusait le programme
            # de l'étudiant — « Échec de compilation » sur du code qu'il n'avait pas écrit.
            read_m = "\n".join(
                '                let a%d = %s;' % (i, RUST_CONV[t] % 'args.next().unwrap_or("")')
                for i, t in enumerate(types))
            pass_item = ", ".join("a%d" % i for i in range(len(types)))
            call_expr_m = "moodit_%s[h].%s(%s)" % (typ.lower(), ident, pass_item)
            if ret == "String":
                call_expr_m = "moodit_hexe(&%s)" % call_expr_m
            branches.append('''            "method|%s.%s" => {
                let h = args.next().unwrap_or("0").parse::<usize>().unwrap_or(0);
%s
                format!("{}|ok|{}", id, %s)
            }''' % (typ, ident, read_m, call_expr_m))
    return "\n".join(stacks), "\n".join(branches)


def rust_grader_source(methods, harness_code, nonce, obj_list=(), field_list=None):
    """Programme NOTEUR Rust : bouchons typés + harnais booléen + nonce. PURE (testée)."""
    stubs = []
    for ret, ident, types in methods:
        params = ", ".join("a%d: %s" % (i, t) for i, t in enumerate(types))
        # Un raccourci « un seul argument » court-circuitait la sérialisation typée, donc
        # l'encodage des chaînes : `copie("a|b")` partait brut et décalait tout l'appel.
        body = rust_send_args(types).replace(' + "|" + ', "", 1) or '""'
        parse = "moodit_dehexe(&brut)" if ret == "String" else "brut.parse::<%s>().unwrap()" % ret
        args = (" + \"|\" + " + body) if types else ""
        stubs.append('''fn %s(%s) -> %s {
    let id = moodit_id();
    let requete = id.clone() + "|call|%s"%s;
    let brut = moodit_appel(&id, &requete);
    %s
}''' % (ident, params, ret, ident, args, parse))
    return '''// Imports ALIASES : le serveur partage le fichier du code soumis, et un `use` identique
// chez l etudiant levait E0252 (import en double) sur du code valide. Les methodes de
// trait marchent des que le trait est en portee, quel que soit son nom.
use std::io::{BufRead as MooditBufRead, Write as MooditWrite};

fn moodit_hexe(s: &str) -> String {
    // Chaine → HEXADECIMAL : le fil est a champs separes par « | », une ligne par message.
    let mut sortie = String::from("H");
    for octet in s.as_bytes() {
        sortie.push_str(&format!("{:02x}", octet));
    }
    sortie
}

fn moodit_dehexe(v: &str) -> String {
    let v = v.trim();
    if !v.starts_with('H') {
        return v.to_string();
    }
    let mut octets = Vec::new();
    let chiffres: Vec<char> = v.chars().skip(1).collect();
    let mut i = 0;
    while i + 1 < chiffres.len() {
        let paire: String = chiffres[i..i + 2].iter().collect();
        octets.push(u8::from_str_radix(&paire, 16).unwrap_or(0));
        i += 2;
    }
    String::from_utf8_lossy(&octets).to_string()
}

fn moodit_id() -> String {
    // Identifiant IMPRÉVISIBLE par appel, tiré de /dev/urandom : sans lui, le code noté — dont
    // le stdout EST le canal de réponse — pouvait imprimer la réponse attendue avant la question.
    let mut brut = [0u8; 8];
    use std::io::Read;
    std::fs::File::open("/dev/urandom").unwrap().read_exact(&mut brut).unwrap();
    brut.iter().map(|o| format!("{:02x}", o)).collect()
}

fn moodit_appel(id: &str, requete: &str) -> String {
    println!("{}", requete);
    std::io::stdout().flush().unwrap();
    let entree = std::io::stdin();
    for ligne in entree.lock().lines() {
        let ligne = match ligne { Ok(l) => l, Err(_) => break };
        let mut parts = ligne.splitn(3, '|');
        let recu = parts.next().unwrap_or("");
        let etat = parts.next().unwrap_or("");
        let valeur = parts.next().unwrap_or("");
        // Seule une réponse portant l'identifiant DE CET APPEL compte.
        if recu != id { continue; }
        if etat != "ok" {
            eprintln!("[MOODIT] appel refuse par le code soumis");
            std::process::exit(3);
        }
        return valeur.to_string();
    }
    eprintln!("[MOODIT] processus etudiant termine");
    std::process::exit(3);
}

%s

%s

fn moodit_harnais() -> bool {
%s
}

fn main() {
    let ok = std::panic::catch_unwind(moodit_harnais).unwrap_or(false);
    if ok {
        eprintln!();
        eprintln!("%s");
        std::io::stderr().flush().unwrap();
        std::process::exit(0);
    }
    std::process::exit(1);
}
''' % ("\n\n".join(stubs), rust_object_stub(obj_list, field_list),
       "\n".join("    " + l if l.strip() else l for l in (harness_code or "").splitlines()),
       nonce)


def rust_server_source(methods, student_source, obj_list=(), field_list=None):
    """Programme ÉTUDIANT Rust : son code + aiguillage typé (fonctions et objets). PURE (testée)."""
    stacks, object_branches = rust_object_dispatch(obj_list, field_list)
    branches = []
    for ret, ident, types in methods:
        # MÊME table que les bouchons et l'aiguillage des objets (RUST_CONV) : une copie à part
        # est restée en arrière à chaque changement d'invariant, et c'est ainsi que l'encodage
        # des chaînes a été oublié une première fois.
        reads = ['            let a%d = %s;' % (i, RUST_CONV[t] % 'args.next().unwrap_or("")')
                    for i, t in enumerate(types)]
        call_expr = "%s(%s)" % (ident, ", ".join("a%d" % i for i in range(len(types))))
        if ret == "String":
            call_expr = "moodit_hexe(&%s)" % call_expr
        branches.append('        "%s" => {\n%s\n            format!("{}|ok|{}", id, %s)\n        }'
                   % (ident, "\n".join(reads), call_expr))
    return '''%s

// ALIASES : le serveur partage le fichier du code soumis, et un `use std::io::Write;` chez
// l'etudiant (banal pour un flush) levait E0252, nom defini deux fois. Les methodes de trait
// marchent des que le trait est en portee, quel que soit son nom.
use std::io::{BufRead as MooditBufRead, Write as MooditWrite};

fn moodit_hexe(s: &str) -> String {
    // Chaine → HEXADECIMAL : le fil est a champs separes par « | », une ligne par message.
    let mut sortie = String::from("H");
    for octet in s.as_bytes() {
        sortie.push_str(&format!("{:02x}", octet));
    }
    sortie
}

fn moodit_dehexe(v: &str) -> String {
    let v = v.trim();
    if !v.starts_with('H') {
        return v.to_string();
    }
    let mut octets = Vec::new();
    let chiffres: Vec<char> = v.chars().skip(1).collect();
    let mut i = 0;
    while i + 1 < chiffres.len() {
        let paire: String = chiffres[i..i + 2].iter().collect();
        octets.push(u8::from_str_radix(&paire, 16).unwrap_or(0));
        i += 2;
    }
    String::from_utf8_lossy(&octets).to_string()
}

fn moodit_serve() {
%s
    let entree = std::io::stdin();
    for ligne in entree.lock().lines() {
        let ligne = match ligne { Ok(l) => l, Err(_) => break };
        let mut args = ligne.split('|');
        let id = args.next().unwrap_or("").to_string();
        let premier = args.next().unwrap_or("").to_string();
        // Protocole : id|op|nom|poignée|args… pour `new`/`method`, id|call|fonction|args…
        // pour une fonction libre. L'op « call » explicite (comme en C) : sans lui, une
        // fonction libre nommée `new` ou `method` était prise pour une opération objet.
        let cle = if premier == "new" || premier == "method" {
            format!("{}|{}", premier, args.next().unwrap_or(""))
        } else if premier == "call" {
            args.next().unwrap_or("").to_string()
        } else {
            String::new()
        };
        let reponse = match cle.as_str() {
%s
%s
            _ => format!("{}|err|fonction inconnue", id),
        };
        print!("\\n{}\\n", reponse);
        std::io::stdout().flush().unwrap();
    }
}

fn main() {
    moodit_serve();
}
''' % (rust_without_main(student_source), stacks, "\n".join(branches), object_branches)


RUST_MAIN = re.compile(r"^[ \t]*fn\s+main\s*\(\s*\)", re.M)


def rust_without_main(source):
    """Code étudiant dont le `main` est renommé : le serveur fournit le point d'entrée. PURE."""
    return RUST_MAIN.sub("fn __moodit_student_main()", source or "")


# ─────────────────── C# : bouchon et aiguillage TYPÉS, protocole texte ───────────────────
# mono autorise l'appel natif (dup2) et la réflexion : c'est précisément pourquoi le noteur doit
# vivre AILLEURS. Ici il n'y a plus rien à détourner dans le processus de l'étudiant.

# Visibilite indifferente, comme en Java : en C# une methode de classe est privee PAR DEFAUT,
# donc exiger `public` refusait l ecriture la plus naturelle d un exercice.
# Memes modificateurs qu en Java, cote C#, y compris les deux formes EN DEUX MOTS
# (`protected internal`, `private protected`) : elles sont couvertes par la repetition.
CS_MODS = (r"(?:public|internal|protected|private|static|new|virtual|override|sealed"
           r"|abstract|extern|unsafe|partial)")
CS_METHOD = re.compile(
    r"(?:^|[{};])[ \t]*(?=(?:" + CS_MODS + r"\s+)*static\s)(?:" + CS_MODS + r"\s+)*"
    r"(int|long|double|bool|string)\s+(\w+)\s*\(([^()]*)\)", re.M)
CS_TYPES = {"int": "int", "long": "long", "double": "double", "bool": "bool", "string": "string"}


# Noms longs d'un type de base, ramenes a leur mot-cle : `String` EST `string`, `Int32` EST
# `int`. Applique a la source d'EXTRACTION seulement — le code compile reste celui de l'etudiant.
CS_ALIAS = {"String": "string", "Int32": "int", "Int64": "long", "Double": "double",
            "Boolean": "bool"}
# Seulement en position de TYPE (suivi d'un identifiant puis de `(`, `,`, `)`, `=` ou `;`) :
# une methode NOMMEE `Double` devenait `double`, mot-cle, et le bouchon ne compilait plus.
CS_ALIAS_RE = re.compile(r"\b(?:System\.)?(String|Int32|Int64|Double|Boolean)\b"
                         r"(?=\s+[A-Za-z_]\w*\s*[(,)=;])")


def cs_canonical_types(src_text):
    """Source C# dont les noms longs de types de base sont ramenes au mot-cle. PURE (testee)."""
    return CS_ALIAS_RE.sub(lambda m: CS_ALIAS[m.group(1)], src_text or "")


def _cs_param_types(params):
    """SEUL lecteur de parametres C#, pour les statiques comme pour le chemin objet. PURE.

    La valeur par defaut (`int n = 5`) et le modificateur `in` ne changent pas le type vu par
    l'appelant ; `ref`/`out` le changent (passage par reference) : refuses."""
    types = []
    for param_group in [p.strip() for p in params.split(",") if p.strip()]:
        pieces = [m for m in param_group.split("=")[0].split() if m != "in"]
        if len(pieces) != 2 or pieces[0] not in CS_TYPES:
            return None
        types.append(pieces[0])
    return types


def cs_signatures(source):
    """Méthodes STATIQUES du code étudiant → [(retour, nom, [types])], visibilité indifférente. PURE (testée)."""
    hits = []
    for ret, ident, params in CS_METHOD.findall(source or ""):
        if ident == "Main":
            continue
        types = _cs_param_types(params)
        if types is not None:
            hits.append((ret, ident, types))
    return dedupe_signatures(hits)


def cs_send_args(types):
    """Sérialisation des arguments C#. FONCTION PURE (testée) — chaîne en hexadécimal, nombre en
    culture INVARIANTE (une concaténation implicite donnait « 3,14 », illisible d'en face)."""
    return "".join(
        ' + "|" + MooditRpc.Hexe(a%d)' % i if t == "string"
        # « G17 » et non le format « G » par défaut : ce dernier n'est pas garanti exact, et un
        # double arrondi à l'affichage faisait noter fausse une réponse juste (comme le %g
        # corrigé en C/C++). C'est bien G17 et non « R » : la documentation .NET déconseille R
        # pour l'aller-retour d'un double, et le runner tourne sur mono.
        else ' + "|" + a%d.ToString("G17", '
             'System.Globalization.CultureInfo.InvariantCulture)' % i if t == "double"
        else ' + "|" + Convert.ToString(a%d, '
             'System.Globalization.CultureInfo.InvariantCulture)' % i
        for i, t in enumerate(types))


# Gabarits de lecture : `v` est le NOM DE L'ARGUMENT, a remplacer par « (v » seulement — un
# remplacement de « v » nu changeait InvariantCulture en InbrutariantCulture (le harnais ne
# compilait plus des qu'une methode rendait un double).
CS_READ = {"int": "int.Parse(v)", "long": "long.Parse(v)",
              "double": "double.Parse(v, System.Globalization.CultureInfo.InvariantCulture)",
              "bool": "bool.Parse(v)", "string": "MooditRpc.Dehexe(v)"}


def cs_object_stub(klass, ctors, method_list):
    """Bouchons OBJET C# : constructeur → poignée, méthodes d'instance → appel sur la poignée.

    FONCTION PURE (testée). `new Rectangle(3, 4).Aire()` s'écrit naturellement dans le harnais,
    alors que l'objet vit dans le processus de l'étudiant."""
    pieces = []
    for types in ctors:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        # Conversion EXPLICITE en culture invariante : une concaténation implicite passe par la
        # culture courante, où un double s'écrit « 3,14 » — illisible par le double.Parse
        # invariant d'en face, donc une réponse juste notée fausse.
        args = cs_send_args(types)
        pieces.append('''    public %s(%s) {
        string id = MooditRpc.Id();
        __h = int.Parse(MooditRpc.Appel(id, id + "|new|%s"%s));
    }''' % (klass, params, rpc_name(klass, types), args))
    for ret, ident, types in method_list:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        # Conversion EXPLICITE en culture invariante : une concaténation implicite passe par la
        # culture courante, où un double s'écrit « 3,14 » — illisible par le double.Parse
        # invariant d'en face, donc une réponse juste notée fausse.
        args = cs_send_args(types)
        reader = CS_READ[ret].replace("(v", "(brut")
        pieces.append('''    public %s %s(%s) {
        string id = MooditRpc.Id();
        string brut = MooditRpc.Appel(id, id + "|method|" + __h + "|%s"%s);
        return %s;
    }''' % (ret, ident, params, rpc_name(ident, types), args, reader))
    return "\n\n".join(pieces)


def cs_grader_source(methods, harness_code, nonce, klass, ctors=(), instance=()):
    """Programme NOTEUR C# : bouchons typés + harnais booléen + nonce. PURE (testée)."""
    stubs = []
    # Les statiques de TOUTES les classes sont aplaties dans `klass`, à côté de ses méthodes
    # d'instance : une statique d'une autre classe de même nom et de mêmes paramètres qu'une
    # méthode d'instance de `klass` donnait deux membres identiques (CS0111). Le noteur ne
    # compilait plus — pour un canari seulement, dont le harnais ne nomme aucune classe — et
    # une réponse juste était accusée de falsification. C# ne surcharge pas par `static` :
    # la méthode d'instance l'emporte (c'est elle que `new Klass().F()` appelle). Un membre du
    # nom de la classe est aussi interdit (CS0542).
    taken = {(ident, tuple(types)) for _, ident, types in instance}
    for ret, ident, types in methods:
        if (ident, tuple(types)) in taken or ident == klass:
            continue
        taken.add((ident, tuple(types)))
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        # Conversion EXPLICITE en culture invariante : une concaténation implicite passe par la
        # culture courante, où un double s'écrit « 3,14 » — illisible par le double.Parse
        # invariant d'en face, donc une réponse juste notée fausse.
        args = cs_send_args(types)
        reader = CS_READ[ret].replace("(v", "(brut")
        stubs.append('''    public static %s %s(%s) {
        string id = MooditRpc.Id();
        string brut = MooditRpc.Appel(id, id + "|%s"%s);
        return %s;
    }''' % (ret, ident, params, rpc_name(ident, types), args, reader))
    return '''using System;
using System.IO;

static class MooditRpc {
    static readonly System.Security.Cryptography.RandomNumberGenerator ALEA =
        System.Security.Cryptography.RandomNumberGenerator.Create();

    // Identifiant IMPRÉVISIBLE par appel : sans lui, le code noté — dont le stdout EST le canal
    // de réponse — pouvait imprimer la réponse attendue avant même la question.
    // Mêmes codecs que le serveur : une chaîne ne voyage qu'en hexadécimal, le fil étant à
    // champs séparés par « | » et à une ligne par message.
    public static string Hexe(string s) {
        // null voyage en JETON « N » (une chaîne, même vide, commence par « H ») : rendu par
        // « H » vide, il arrivait en "" — `== null` noté faux sur une réponse juste.
        if (s == null) { return "N"; }
        byte[] brut = System.Text.Encoding.UTF8.GetBytes(s);
        return "H" + BitConverter.ToString(brut).Replace("-", "").ToLowerInvariant();
    }

    public static string Dehexe(string v) {
        v = (v ?? "").Trim();
        if (v == "N") { return null; }
        if (!v.StartsWith("H")) { return v; }
        byte[] octets = new byte[(v.Length - 1) / 2];
        for (int i = 0; i < octets.Length; i++) {
            octets[i] = Convert.ToByte(v.Substring(1 + i * 2, 2), 16);
        }
        return System.Text.Encoding.UTF8.GetString(octets);
    }

    public static string Id() {
        byte[] brut = new byte[8];
        ALEA.GetBytes(brut);
        return BitConverter.ToString(brut).Replace("-", "");
    }

    public static string Appel(string id, string requete) {
        Console.Out.WriteLine(requete);
        Console.Out.Flush();
        string ligne;
        while ((ligne = Console.In.ReadLine()) != null) {
            string[] parts = ligne.Split(new char[] { '|' }, 3);
            if (parts.Length < 3 || parts[0] != id) { continue; }   // bruit, ou devancement
            if (parts[1] != "ok") {
                Console.Error.WriteLine("[MOODIT] appel refuse par le code soumis");
                Environment.Exit(3);
            }
            return parts[2];
        }
        Console.Error.WriteLine("[MOODIT] processus etudiant termine");
        Environment.Exit(3);
        return "";
    }
}

public class %s {
    // Pas de constructeur « à poignée » : personne ne l'appelait, et avec un constructeur du
    // code soumis prenant un seul int — `new Compteur(0)`, l'idiome le plus courant — les deux
    // signatures devenaient identiques. C# n'autorise pas la surcharge par accessibilité : le
    // noteur ne compilait plus et la question rendait 0 sans diagnostic.
    private readonly int __h;
%s
%s
}

public static class MooditGrader {
    static bool Harnais() {
%s
    }

    public static int Main(string[] args) {
        bool ok;
        try {
            ok = Harnais();
        } catch (Exception e) {
            Console.Error.WriteLine("[MOODIT] harnais: " + e.Message);
            ok = false;
        }
        if (ok) {
            Console.Error.WriteLine();
            Console.Error.WriteLine("%s");
            Console.Error.Flush();
            return 0;
        }
        return 1;
    }
}
''' % (klass, cs_object_stub(klass, ctors, instance), "\n\n".join(stubs),
       "\n".join("        " + l if l.strip() else l
                 for l in (harness_code or "").splitlines()), nonce)


def cs_server_source(classes, namespaces=()):
    """Programme ÉTUDIANT C# : son code (compilé à côté) + aiguillage par réflexion. PURE.

    Les espaces de noms du code soumis sont importés : sans cela, `typeof(Solution)` ne
    trouvait pas une classe écrite dans `namespace Quiz { … }`."""
    return "".join("using %s;\n" % n for n in namespaces) + '''using System;
using System.Reflection;

public static class MooditServer {
    // Objets construits CHEZ L'ÉTUDIANT : le noteur n'en connaît que la poignée.
    static readonly System.Collections.Generic.List<object> OBJETS =
        new System.Collections.Generic.List<object>();

    // Chaîne → HEXADÉCIMAL sur le fil : le protocole est à champs séparés par « | » et à une
    // ligne par message, donc un « | » ou un saut de ligne dans la valeur décalait tout l'appel.
    public static string Hexe(string s) {
        // null voyage en JETON « N » (une chaîne, même vide, commence par « H ») : rendu par
        // « H » vide, il arrivait en "" — `== null` noté faux sur une réponse juste.
        if (s == null) { return "N"; }
        byte[] brut = System.Text.Encoding.UTF8.GetBytes(s);
        return "H" + BitConverter.ToString(brut).Replace("-", "").ToLowerInvariant();
    }

    public static string Dehexe(string v) {
        v = (v ?? "").Trim();
        if (v == "N") { return null; }
        if (!v.StartsWith("H")) { return v; }
        byte[] octets = new byte[(v.Length - 1) / 2];
        for (int i = 0; i < octets.Length; i++) {
            octets[i] = Convert.ToByte(v.Substring(1 + i * 2, 2), 16);
        }
        return System.Text.Encoding.UTF8.GetString(octets);
    }

    static object[] Convertis(ParameterInfo[] attendus, string[] parts, int depart) {
        object[] donnes = new object[attendus.Length];
        for (int i = 0; i < attendus.Length; i++) {
            string brut = parts[i + depart];
            Type pt = attendus[i].ParameterType;
            if (pt.IsByRef) { pt = pt.GetElementType(); }   // parametre `in` : int& -> int
            if (pt == typeof(string)) {
                donnes[i] = Dehexe(brut);
                continue;
            }
            donnes[i] = Convert.ChangeType(brut, pt,
                    System.Globalization.CultureInfo.InvariantCulture);
        }
        return donnes;
    }

    /** Nom sans sa signature : `F(int,double)` donne `F`. */
    static string Base(string appel) {
        int p = appel.IndexOf('(');
        return p < 0 ? appel : appel.Substring(0, p);
    }

    static string NomType(Type t) {
        if (t.IsByRef) { t = t.GetElementType(); }   // parametre `in`
        if (t == typeof(int)) { return "int"; }
        if (t == typeof(long)) { return "long"; }
        if (t == typeof(double)) { return "double"; }
        if (t == typeof(bool)) { return "bool"; }
        if (t == typeof(string)) { return "string"; }
        return t.FullName;
    }

    // La surcharge VISEE par le bouchon : memes types de parametres, dans l'ordre. Le nom et
    // l'arite seuls prenaient la premiere de meme arite, et une reponse juste pouvait etre
    // notee fausse des que le code soumis declarait F(int) et F(double).
    static bool Signe(ParameterInfo[] attendus, string appel, int arite) {
        if (attendus.Length != arite) { return false; }
        int p = appel.IndexOf('(');
        if (p < 0) { return true; }
        string[] noms = new string[attendus.Length];
        for (int i = 0; i < attendus.Length; i++) { noms[i] = NomType(attendus[i].ParameterType); }
        return string.Join(",", noms) == appel.Substring(p + 1, appel.Length - p - 2);
    }

    /** Valeur de retour sur le fil : une chaîne part encodée. */
    static string Sortie(object v) {
        // Seule une méthode à retour string peut rendre null ici (types valeur sinon).
        if (v == null) { return Hexe(null); }
        if (v is string) { return Hexe((string) v); }
        // « G17 » (et « G9 » pour un float) : aller-retour exact, que le format « G » par
        // défaut ne garantit pas. La documentation .NET déconseille « R » pour un double.
        if (v is double) {
            return ((double) v).ToString("G17",
                    System.Globalization.CultureInfo.InvariantCulture);
        }
        if (v is float) {
            return ((float) v).ToString("G9",
                    System.Globalization.CultureInfo.InvariantCulture);
        }
        return Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
    }

    public static int Main(string[] args) {
        string ligne;
        while ((ligne = Console.In.ReadLine()) != null) {
            string[] parts = ligne.Split('|');
            string id = parts.Length > 0 ? parts[0] : "";
            string nom = parts.Length > 1 ? parts[1] : "";
            string reponse;
            try {
                if (nom == "new") {
                    Type cible2 = typeof(%s);
                    bool construit = false;
                    foreach (var c in cible2.GetConstructors(
                            BindingFlags.Public | BindingFlags.NonPublic
                            | BindingFlags.Instance)) {
                        if (!Signe(c.GetParameters(), parts[2], parts.Length - 3)) { continue; }
                        OBJETS.Add(c.Invoke(Convertis(c.GetParameters(), parts, 3)));
                        construit = true;
                        break;
                    }
                    // Aucun constructeur de cette arité : il faut le DIRE. Sans ce refus, on
                    // rendait la poignée d'un objet précédent (ou -1), et le harnais notait
                    // ensuite un objet qui n'était pas celui qu'il avait demandé.
                    if (!construit) { throw new MissingMethodException(cible2.Name); }
                    Console.Out.Write("\\n" + id + "|ok|" + (OBJETS.Count - 1) + "\\n");
                    Console.Out.Flush();
                    continue;
                }
                if (nom == "method") {
                    object instance = OBJETS[int.Parse(parts[2])];
                    string nomMethode = Base(parts[3]);
                    MethodInfo cible3 = null;
                    foreach (MethodInfo m in instance.GetType().GetMethods(
                            BindingFlags.Public | BindingFlags.NonPublic
                            | BindingFlags.Instance)) {
                        if (m.Name == nomMethode && Signe(m.GetParameters(), parts[3], parts.Length - 4)) {
                            cible3 = m;
                            break;
                        }
                    }
                    if (cible3 == null) { throw new MissingMethodException(nomMethode); }
                    object v = cible3.Invoke(instance, Convertis(cible3.GetParameters(), parts, 4));
                    Console.Out.Write("\\n" + id + "|ok|" + Sortie(v) + "\\n");
                    Console.Out.Flush();
                    continue;
                }
                MethodInfo cible = null;
                // Toutes les classes du code soumis, principale d'abord : meme perimetre
                // que l'extraction et que le bouchon, qui aplatit leurs statiques.
                foreach (Type __t in new Type[] { %s }) {
                    foreach (MethodInfo m in __t.GetMethods(
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)) {
                        if (m.Name == Base(nom) && Signe(m.GetParameters(), nom, parts.Length - 2)) {
                            cible = m;
                            break;
                        }
                    }
                    if (cible != null) { break; }
                }
                if (cible == null) { throw new MissingMethodException(nom); }
                // UNE seule conversion pour les trois chemins (fonction, constructeur, méthode) :
                // cette boucle-ci était écrite à part et ne décodait pas les chaînes, donc un
                // argument contenant « | » arrivait mutilé et une réponse juste était notée
                // fausse — sur le chemin le plus courant, celui de l'appel de fonction.
                object valeur = cible.Invoke(null, Convertis(cible.GetParameters(), parts, 2));
                reponse = id + "|ok|" + Sortie(valeur);
            } catch (Exception e) {
                reponse = id + "|err|" + e.Message.Replace('|', ' ');
            }
            Console.Out.Write("\\n" + reponse + "\\n");
            Console.Out.Flush();
        }
        return 0;
    }
}
''' % (classes[0], ", ".join("typeof(" + c + ")" for c in classes))


# Meme relaxation qu en Java, et pour la meme raison : en C# un membre est prive PAR DEFAUT.
# ANCREES EN DEBUT DE LIGNE : sans cela, `public` devenu facultatif, un `new Rectangle(3, 4)`
# au milieu d une expression serait pris pour une declaration de constructeur.
CS_CTOR_TPL = (r"(?:^|[{};])[ \t]*(?:(?:public|internal|protected|private|static|extern)\s+)*"
               r"%s\s*\(([^()]*)\)")
CS_INSTANCE = re.compile(
    r"(?:^|[{};])[ \t]*(?!(?:" + CS_MODS + r"\s+)*static\s)(?:" + CS_MODS + r"\s+)*"
    r"(int|long|double|bool|string)\s+(\w+)\s*\(([^()]*)\)", re.M)


def cs_object_api(source, klass):
    """API OBJET d'une classe C# → ([constructeurs], [méthodes d'instance]). PURE (testée).

    Lue à la REGEX comme le reste du chemin C# : le prof n'a rien à déclarer, et une signature
    hors types marshalables est simplement écartée (le harnais qui l'appelle ne compilera pas)."""
    param_types_of = _cs_param_types   # le MEME lecteur que les statiques

    ctors = []
    # re.M est INDISPENSABLE : le gabarit est ancre en debut de LIGNE (sans quoi un
    # `new Rectangle(3, 4)` passerait pour une declaration), et sans ce drapeau `^` ne
    # vaudrait que pour le debut du fichier — aucun constructeur ne serait trouve.
    for params in re.findall(CS_CTOR_TPL % re.escape(klass), source or "", re.M):
        types = param_types_of(params)
        if types is not None:
            ctors.append(types)
    # AUCUN constructeur declare : C# fournit le constructeur par defaut, comme Java.
    # Seulement pour une classe DECLAREE dans le code soumis.
    declares = re.findall(CS_CTOR_TPL % re.escape(klass), source or "", re.M)
    if not declares and re.search(r"\bclass\s+%s\b" % re.escape(klass), source or ""):
        ctors = [[]]
    method_list = []
    src_text = source or ""
    for begin, finish, level in class_bodies(src_text, r"\bclass\s+%s\b" % re.escape(klass)):
        depths = _closings(src_text)[0]
        for m in CS_INSTANCE.finditer(src_text, begin, finish):
            # Membre DIRECT de la classe visee : une autre classe du fichier (Carre a cote de
            # Rectangle) ou une classe imbriquee donnaient des bouchons en double, que mcs
            # refusait (CS0111) — une reponse juste notee 0.
            if depths[m.start(2)] != level:
                continue
            types = param_types_of(m.group(3))
            if types is not None and m.group(2) != "Main":
                method_list.append((m.group(1), m.group(2), types))
    return ctors, dedupe_signatures(method_list)


def class_bodies(src_text, header_pattern):
    """Corps des classes dont l'entete correspond : [(debut, fin, profondeur des membres)].
    PURE (testee). Appariement LEXICAL (block_end) : une accolade en litteral ne compte pas."""
    body = []
    for header in re.finditer(header_pattern, src_text):
        begin = src_text.find("{", header.end())
        if begin < 0:
            continue
        # `class Rect;` (declaration anticipee) : l'accolade trouvee appartient a la suite.
        if ";" in src_text[header.end():begin]:
            continue
        body.append((begin, block_end(src_text, begin), _closings(src_text)[0][begin] + 1))
    return body


CS_CLASS = re.compile(r"\bclass\s+(\w+)")


def _digit_separator(src_text, i):
    """L'apostrophe en `i` est-elle un séparateur de chiffres (`1'000`, `0xFF'FF`) ? PURE.

    Oui si elle suit un jeton NUMÉRIQUE (qui commence par un chiffre) et précède un chiffre
    hexadécimal. Les préfixes de caractère (`L'a'`, `u'a'`, `u8'a'`) commencent par une lettre,
    et `x = 'a'` n'a pas de jeton collé devant : ils restent des littéraux."""
    if i + 1 >= len(src_text) or src_text[i + 1] not in "0123456789abcdefABCDEF":
        return False
    j = i
    while j > 0 and (src_text[j - 1].isalnum() or src_text[j - 1] in "_'"):
        j -= 1
    return j < i and src_text[j].isdigit()


def blank_code(src_text, backticks=False, rust=False):
    """Source sans commentaires ni litteraux, pour l EXTRACTION seulement (lignes preservees).

    Une fonction gardee en commentaire de bloc etait extraite comme une vraie signature :
    bouchon en double, echec de compilation, 0 sur une reponse juste. Porte du correctif C#
    aux quatre autres langages. `backticks` couvre les chaines brutes Go ; `rust` masque
    d abord les litteraux de caractere via CHAR_LITERAL (une apostrophe de lifetime n ouvre
    pas une chaine) et gere les chaines brutes r"..."/r#"..."#."""
    src_text = src_text or ""
    if rust:
        src_text = CHAR_LITERAL.sub(lambda m: " " * len(m.group(0)), src_text)
    res = []
    i = 0
    n = len(src_text)
    while i < n:
        c = src_text[i]
        two_chars = src_text[i:i + 2]
        if two_chars == "//":
            while i < n and src_text[i] != chr(10):
                res.append(" ")
                i += 1
        elif two_chars == "/*":
            res.append("  ")
            i += 2
            depth = 1
            while i < n and depth:
                if rust and src_text[i:i + 2] == "/*":
                    depth += 1
                    res.append("  ")
                    i += 2
                elif src_text[i:i + 2] == "*/":
                    depth -= 1
                    res.append("  ")
                    i += 2
                else:
                    res.append(src_text[i] if src_text[i] == chr(10) else " ")
                    i += 1
        elif rust and c == "r" and src_text[i + 1:i + 2] in ('"', "#"):
            j = i + 1
            hashes = 0
            while src_text[j:j + 1] == "#":
                hashes += 1
                j += 1
            if src_text[j:j + 1] != '"':
                res.append(c)
                i += 1
                continue
            finish = '"' + "#" * hashes
            k = src_text.find(finish, j + 1)
            k = n if k < 0 else k + len(finish)
            for x in src_text[i:k]:
                res.append(x if x == chr(10) else " ")
            i = k
        elif backticks and c == "`":
            res.append(" ")
            i += 1
            while i < n and src_text[i] != "`":
                res.append(src_text[i] if src_text[i] == chr(10) else " ")
                i += 1
            if i < n:
                res.append(" ")
                i += 1
        elif not rust and c == chr(39) and _digit_separator(src_text, i):
            # Séparateur de chiffres C++14 (`1'000`) : pas un littéral. Le prendre pour une
            # ouverture blanchissait la suite jusqu'à la prochaine apostrophe, et les fonctions
            # suivantes disparaissaient de l'extraction (« aucune fonction exploitable »).
            res.append(c)
            i += 1
        elif c == '"' or (not rust and c == chr(39)):
            quote = c
            res.append(" ")
            i += 1
            while i < n and src_text[i] != quote:
                if src_text[i] == chr(92) and i + 1 < n:
                    res.append("  ")
                    i += 2
                else:
                    res.append(src_text[i] if src_text[i] == chr(10) else " ")
                    i += 1
            if i < n:
                res.append(" ")
                i += 1
        else:
            res.append(c)
            i += 1
    return "".join(res)


def cs_strip_comments(src_text):
    """Source C# sans commentaires ni litteraux (remplaces par des espaces, lignes preservees).

    Un `class X` dans un commentaire ou une chaine leurrait le choix de la classe principale et
    la liste des `typeof` du serveur : un etudiant qui gardait une ancienne version en
    commentaire voyait sa soumission correcte echouer sur un type qu'il n'a pas ecrit. PURE
    (testee). Verbatim `@"..."` (ou `""` echappe un guillemet et `\\` est litteral) et
    interpolees `$"..."` comprises."""
    res = []
    i = 0
    n = len(src_text or "")
    src_text = src_text or ""
    while i < n:
        two_chars = src_text[i:i + 2]
        if two_chars == "//":
            while i < n and src_text[i] != chr(10):
                res.append(" ")
                i += 1
        elif two_chars == "/*":
            res.append("  ")
            i += 2
            while i < n and src_text[i:i + 2] != "*/":
                res.append(src_text[i] if src_text[i] == chr(10) else " ")
                i += 1
            if i < n:
                res.append("  ")
                i += 2
        elif two_chars == '@"' or src_text[i:i + 3] in ('$@"', '@$"'):
            newline = 3 if src_text[i:i + 3] in ('$@"', '@$"') else 2
            res.append(" " * newline)
            i += newline
            while i < n:
                if src_text[i] == '"':
                    if src_text[i + 1:i + 2] == '"':
                        res.append("  ")
                        i += 2
                        continue
                    res.append(" ")
                    i += 1
                    break
                res.append(src_text[i] if src_text[i] == chr(10) else " ")
                i += 1
        elif src_text[i] in ('"', chr(39)):
            quote = src_text[i]
            res.append(" ")
            i += 1
            while i < n and src_text[i] != quote:
                if src_text[i] == chr(92) and i + 1 < n:
                    res.append("  ")
                    i += 2
                else:
                    res.append(src_text[i] if src_text[i] == chr(10) else " ")
                    i += 1
            if i < n:
                res.append(" ")
                i += 1
        else:
            res.append(src_text[i])
            i += 1
    return "".join(res)


CS_TOKENS = re.compile(r"[{};]|\bclass\s+(\w+)(\s*<)?")
CS_NAMESPACE = re.compile(r"\bnamespace\s+([\w.]+)")


def cs_top_level_classes(source):
    """Classes de PREMIER NIVEAU du code soumis, dans l'ordre, sans doublon. PURE (testee).

    Premier niveau = enfermee seulement dans des `namespace`. Une classe IMBRIQUEE n'est pas
    visible sous son nom depuis le serveur (`typeof(Rect)` ne compilait pas), et le code
    soumis ne compilait plus.

    Une classe GENERIQUE (`Pile<T>`) est ecartee : `typeof(Pile)` ne compile pas (CS0305) et
    faisait echouer TOUT le serveur, donc tous les cas d'une reponse juste. Ses membres ne
    sont de toute facon pas appelables par le fil (type ouvert)."""
    src_text = source or ""
    idents, stack, segment = [], [], 0
    for m in CS_TOKENS.finditer(src_text):
        if m.group(1):
            if m.group(2):
                continue
            if all(stack) and m.group(1) not in idents:
                idents.append(m.group(1))
            continue
        if m.group(0) == "{":
            stack.append(bool(re.match(r"\s*namespace\s+[\w.]+\s*$", src_text[segment:m.start()])))
        elif m.group(0) == "}" and stack:
            stack.pop()
        segment = m.end()
    return idents


def cs_namespaces(source):
    """Espaces de noms declares (bloc ou fichier) : le serveur les importe. PURE (testee)."""
    seen_names = []
    for ident in CS_NAMESPACE.findall(source or ""):
        if ident not in seen_names:
            seen_names.append(ident)
    return seen_names


def cs_student_class(source, harness=""):
    """Classe que le harnais appellera. PURE (testee).

    La PREMIERE classe ne l'est pas forcement : une classe d'aide declaree avant Solution
    recevait les bouchons, et `Solution.F()` du harnais ne compilait plus. On prend la premiere
    classe de premier niveau que le harnais NOMME, sinon Solution, sinon la premiere."""
    classes = cs_top_level_classes(source)
    bare = cs_strip_comments(harness or "")
    for ident in classes:
        if re.search(r"\b%s\b" % re.escape(ident), bare):
            return ident
    if "Solution" in classes:
        return "Solution"
    return classes[0] if classes else "Solution"


def cs_has_object_api(source):
    """Une classe de PREMIER NIVEAU offre-t-elle un constructeur et une méthode d'instance ?
    PURE (testée). Indépendant du harnais, pour que canaris et cas réels soient refusés ou
    acceptés ensemble."""
    for ident in cs_top_level_classes(source):
        ctors, instance = cs_object_api(source, ident)
        if ctors and instance:
            return True
    return False


def cs_student_classes(source, harness=""):
    """Classes de PREMIER NIVEAU, la principale d'abord. PURE (testee).

    Le serveur doit chercher une statique dans le même périmètre que l'extraction
    (`cs_signatures`, toute la source) et que le bouchon, qui aplatit ces statiques dans la
    classe principale."""
    main_class = cs_student_class(source, harness)
    return [main_class] + [n for n in cs_top_level_classes(source) if n != main_class]


def grader_uid():
    """UID du NOTEUR : distinct de celui de l'étudiant, sans entrée dans /etc/passwd (setuid
    prend un numéro). C'est cette séparation qui rend /proc/<pid>/mem du noteur inaccessible au
    code noté, quelles que soient les règles de ptrace de l'hôte."""
    return STUDENT_UID + 1


def demote_grader():
    """preexec_fn du processus NOTEUR : son propre UID, son propre groupe de processus."""
    os.setsid()
    os.setgroups([])
    os.setgid(grader_uid())
    os.setuid(grader_uid())
    resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_LIMIT, FSIZE_LIMIT))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))


def run_pair(grader_cmd, student_cmd, cwd, g_env, s_env, timeout_s, g_err_path, s_err_path):
    """Lance le NOTEUR et le processus ÉTUDIANT avec des tubes CROISÉS et des UID distincts.

    → (code du noteur, expiré, stderr du noteur, stderr de l'étudiant).

    stdout/stdin du noteur sont le tube vers l'étudiant ; son stderr — où atterrit le nonce —
    n'est tenu par personne d'autre que root. Le noteur PILOTE : quand il a fini, l'étudiant n'a
    plus de raison de vivre, et c'est son EOF qui l'arrête (ou un kill, s'il s'accroche)."""
    req_r, req_w = os.pipe()        # noteur → étudiant
    rep_r, rep_w = os.pipe()        # étudiant → noteur
    g_err = s_err = None
    procs = []
    try:
        g_err, s_err = open_output(g_err_path), open_output(s_err_path)
        grader_proc = subprocess.Popen(grader_cmd, cwd=cwd, env=g_env, stdin=rep_r, stdout=req_w,
                                       stderr=g_err, preexec_fn=demote_grader)
        procs.append(grader_proc)
        student_side = subprocess.Popen(student_cmd, cwd=cwd, env=s_env, stdin=req_r, stdout=rep_w,
                                    stderr=s_err, preexec_fn=demote_student)
        procs.append(student_side)
        for fd in (req_r, req_w, rep_r, rep_w):
            os.close(fd)            # le parent lâche les quatre extrémités : EOF se propage
        expired = False
        try:
            code = grader_proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            code, expired = None, True
        for proc in procs:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                proc.wait(timeout=PUMP_SWEEP_JOIN_S)
            except subprocess.TimeoutExpired:
                pass
        kill_student_survivors()
        purge_shared_dirs()
        return code, expired, read_capped(g_err_path), read_capped(s_err_path)
    except OSError as e:
        for fd in (req_r, req_w, rep_r, rep_w):
            try:
                os.close(fd)
            except OSError:
                pass
        EXIT_STATE.lost = True
        event("espace_sature", case=EXIT_STATE.case, detail="lancement du couple impossible : %r" % e)
        return None, False, "", ""
    finally:
        for stream in (g_err, s_err):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    EXIT_STATE.lost = True


def run_java_rpc(case_dir, env, timeout_s, case_index):
    """Notation NON FALSIFIABLE d'un cas Java : harnais booléen, deux processus, deux UID.

    Le code étudiant est compilé SEUL (il ne voit jamais le harnais) ; ses signatures sont lues
    avec javap ; un bouchon de mêmes signatures est compilé AVEC le harnais du prof et le nonce.
    Verdict = le nonce est présent sur le stderr du noteur. L'étudiant ne peut pas le produire :
    il n'est ni dans son processus, ni dans ses fichiers, ni dans sa mémoire."""
    src = os.path.join(case_dir, "src")
    student_src = os.path.join(case_dir, "etu_src")
    student_classes = os.path.join(case_dir, "etu_classes")
    grader_src = os.path.join(case_dir, "not_src")
    grader_classes = os.path.join(case_dir, "not_classes")
    for d in (student_src, student_classes, grader_src, grader_classes):
        os.makedirs(d, exist_ok=True)
    # Le dossier du NOTEUR est ferme des sa naissance, et la compilation ETUDIANTE tourne sous
    # l'UID etudiant dans des dossiers a lui — meme regime que les quatre langages a inclusion
    # textuelle, pour un seul invariant au lieu de six.
    os.chmod(grader_src, 0o700)
    os.chmod(grader_classes, 0o700)
    lock_src_dir(case_dir)
    build_area = student_build_dir(case_dir)
    for d in (student_src, student_classes):
        os.chown(d, STUDENT_UID, STUDENT_GID)
        os.chmod(d, 0o700)

    # 1. Le code étudiant, SEUL. Son fichier harnais n'est même pas copié ici.
    student_file = None
    for ident in sorted(os.listdir(src)):
        if not ident.endswith(".java") or ident.startswith("Moodit"):
            continue
        with open(os.path.join(src, ident), "r", encoding="utf-8", errors="replace") as f:
            body_text = f.read()
        if "__MOODIT_HARNAIS__" in body_text:
            continue                      # le harnais du prof ne suit JAMAIS l'etudiant
        student_file = os.path.join(student_src, ident)
        with open(student_file, "w", encoding="utf-8") as f:
            f.write(body_text)
        set_owner_mode(student_file, STUDENT_UID, STUDENT_GID, 0o600)
        student_content = body_text
    if student_file is None:
        return None, "Aucun fichier de code soumis"
    # Un `package ...;` fait compiler la classe dans un SOUS-DOSSIER : la decouverte plate des
    # .class la manquait, javap tournait sans classe, et le cas tombait dans « aucune methode
    # exploitable » — un 0 avec un message qui ne designe pas la cause. On le DIT, au lieu de
    # rethreader le nom qualifie dans tout le pipeline (risque de recreer le defaut qu on ferme).
    # Source BLANCHIE : un `package` en commentaire ou chaine ne declenche rien.
    if PACKAGE_JAVA.search(blank_code(student_content)):
        return None, ("Retire la ligne « package ... ; » en tete du fichier : la notation "
                      "attend la classe dans le paquet par defaut. (Le bouton « Executer » "
                      "l accepte, pas la notation.)")
    code, expired = run_proc(["javac", "-encoding", "UTF-8", "-d", student_classes, student_file],
                            case_dir, student_build_env(build_area), COMPILE_TIMEOUT_S,
                            os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                            preexec_student_compile)
    if expired or code != 0:
        return None, "Échec de compilation :\n" + read_capped(os.path.join(case_dir, "cc.err"))[:1500]

    # 2. Signatures, lues sur les CLASSES compilées — le prof n'a rien à déclarer. On lit AUSSI
    #    les classes imbriquées (Outer$Inner), pour proxifier les objets : le harnais écrit
    #    `new Solution.Rectangle(3, 4).aire()` et l'objet vit, lui, chez l'étudiant.
    klass = os.path.basename(student_file)[:-len(".java")]
    # Classes ANONYMES et LOCALES ecartees (java_nameable_class) : le harnais ne peut pas les
    # nommer, et leur bouchon ne compilait pas.
    binary_names = sorted(ident[:-len(".class")] for ident in os.listdir(student_classes)
                      if ident.endswith(".class") and not ident.startswith("Moodit")
                      and java_nameable_class(ident[:-len(".class")]))
    code, expired = run_proc(["javap", "-p", "-cp", student_classes] + binary_names,
                            case_dir, env, LIST_TIMEOUT_S,
                            os.path.join(case_dir, "javap.out"), os.path.join(case_dir, "javap.err"),
                            preexec_compile)
    javap = read_capped(os.path.join(case_dir, "javap.out"))
    method_list = java_signatures(javap)
    # Une déclaration de classe par bloc : on les sépare pour lire l'API objet de chacune.
    obj_list = []
    own_ctors, own_instance = (), ()
    for block in re.split(r"(?=^Compiled from )", javap, flags=re.M):
        source_name, ctors, instance = java_class_api(block)
        if not source_name or not (ctors or instance):
            continue
        if source_name == klass:
            # La classe publique peut ÊTRE l'objet à instancier (question POO dont la classe
            # s'appelle Rectangle) : son bouchon porte alors le constructeur et les méthodes.
            own_ctors, own_instance = ctors, instance
        else:
            obj_list.append((source_name, ctors, instance))
    if expired or code != 0 or not (method_list or obj_list or (own_ctors and own_instance)):
        return None, ("Aucune méthode statique ni objet exploitable dans la classe "
                      + klass + " (types acceptés : int, long, double, boolean, String).")

    # 3. Le NOTEUR : bouchon + harnais du prof + nonce. Aucune ligne de code étudiant.
    harness = ""
    for ident in sorted(os.listdir(src)):
        if ident.endswith(".java"):
            with open(os.path.join(src, ident), "r", encoding="utf-8", errors="replace") as f:
                body_text = f.read()
            if "__MOODIT_HARNAIS__" in body_text:
                harness = body_text.split("__MOODIT_HARNAIS__", 1)[1].lstrip("\n")
    shadowed = java_shadowed_names(
        [klass] + [name for name, _, _ in obj_list if "." not in name], harness)
    if shadowed:
        return None, ("Nom de classe réservé : %s %s déjà fourni%s au harnais par java.lang. "
                      "Le harnais ne pourrait pas distinguer votre classe de celle-ci ; "
                      "renommez-la."
                      % (", ".join("« %s »" % n for n in shadowed),
                         "est" if len(shadowed) == 1 else "sont",
                         "" if len(shadowed) == 1 else "s"))
    write_private(os.path.join(grader_src, klass + ".java"),
                 java_stub_source(klass, method_list, obj_list, own_ctors, own_instance))
    write_private(os.path.join(grader_src, "MooditGrader.java"),
                 java_grader_source(harness, TOKENS.get(case_index) or ""))
    code, expired = run_proc(["javac", "-encoding", "UTF-8", "-d", grader_classes,
                             os.path.join(grader_src, klass + ".java"),
                             os.path.join(grader_src, "MooditGrader.java")],
                            case_dir, env, COMPILE_TIMEOUT_S,
                            os.path.join(case_dir, "nc.out"), os.path.join(case_dir, "nc.err"),
                            preexec_compile)
    if expired or code != 0:
        return None, harness_build_failure(expired, code, "contre la signature du code soumis",
                                           read_capped(os.path.join(case_dir, "nc.err"))[:1500])

    # 4. Le serveur de l'étudiant, compilé AVEC ses classes.
    with open(os.path.join(student_src, "MooditServer.java"), "w", encoding="utf-8") as f:
        f.write(java_server_source([klass] + [b for b in binary_names if b != klass]))
    code, expired = run_proc(["javac", "-encoding", "UTF-8", "-cp", student_classes, "-d", student_classes,
                             os.path.join(student_src, "MooditServer.java")],
                            case_dir, env, COMPILE_TIMEOUT_S,
                            os.path.join(case_dir, "sc.out"), os.path.join(case_dir, "sc.err"),
                            preexec_compile)
    if expired or code != 0:
        return None, "Erreur interne du noteur (serveur RPC)"

    # 5. CLOISONNEMENT : chacun chez soi, 700. L'étudiant ne peut pas lire le noteur (ni son
    #    binaire, ni sa source, ni — UID distinct — sa mémoire) ; le harnais du prof est hors
    #    d'atteinte par construction.
    lock_sources(src)
    for fpath in (grader_src, grader_classes):
        set_owner_mode_tree(fpath, grader_uid(), grader_uid(), 0o700, 0o700)
    # etu_classes a ete rempli par la compilation ETUDIANTE : aucun lien n'y est suivi.
    for fpath in (student_src, student_classes):
        set_owner_mode_tree(fpath, STUDENT_UID, STUDENT_GID, 0o700, 0o700)
    prep_run(case_dir, src)

    # 6. Un HOME et un tmp PAR PROCESSUS, du bon propriétaire : une JVM sans tmpdir inscriptible
    #    ne démarre pas, et faire pointer le noteur dans le work/ de l'étudiant lui donnerait un
    #    point d'écriture commun — exactement ce qu'on cloisonne.
    work = os.path.join(case_dir, "work")
    os.makedirs(work, exist_ok=True)
    os.chmod(work, 0o755)
    student_tmp = student_dir(work, "tmp")
    student_home = student_dir(work, "home")
    grader_tmp = grader_dir(case_dir, "noteur_tmp")
    grader_home = grader_dir(case_dir, "noteur_home")
    g_env = dict(env, HOME=grader_home, TMPDIR=grader_tmp)
    s_env = dict(env, HOME=student_home, TMPDIR=student_tmp)

    # 7. Les deux processus, tubes croisés.
    code, expired, g_err, s_err = run_pair(
        ["java", "-XX:MaxRAMPercentage=35", "--illegal-native-access=deny",
         "--sun-misc-unsafe-memory-access=deny", "-Djava.io.tmpdir=" + grader_tmp,
         "-cp", grader_classes, "MooditGrader"],
        ["java", "-XX:MaxRAMPercentage=35", "--illegal-native-access=deny",
         "--sun-misc-unsafe-memory-access=deny", "-Djava.io.tmpdir=" + student_tmp,
         "-cp", student_classes, "MooditServer"],
        case_dir, g_env, s_env, timeout_s,
        os.path.join(case_dir, "grader.err"), os.path.join(case_dir, "student.err"))
    if expired:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None

    # Même verdict que le chemin commun : le message du NOTEUR d'abord — c'est le harnais du
    # prof qui a échoué, et présenter le stderr de l'étudiant désignait le mauvais fautif.
    passed, detail = rpc_verdict(TOKENS.get(case_index) or "", g_err, s_err)
    # Noteur MORT PAR SIGNAL (OOM...) : cause NON CONCLUANTE. Sans ce marquage, un canari
    # « pass » tue par manque de memoire passait pour un canari en echec, et faisait
    # accuser de falsification une soumission dont un vrai cas avait reussi.
    grader_dead = grader_killed(code, passed)
    return CaseOutcome(passed, detail, ran=True, killed=grader_dead), None


def run_csharp_rpc(case_dir, env, timeout_s, case_index):
    """Notation NON FALSIFIABLE d'un cas C# : harnais booléen, deux assemblages, deux UID.

    mono autorise l'appel natif et la réflexion — c'est exactement pourquoi le noteur est
    AILLEURS : il n'y a plus rien à détourner ni à inspecter dans le processus de l'étudiant."""
    src = os.path.join(case_dir, "src")
    student_source = ""
    for ident in sorted(os.listdir(src)):
        if ident == "solution.cs":
            with open(os.path.join(src, ident), "r", encoding="utf-8", errors="replace") as f:
                student_source = f.read()
    # L extraction lit la source DEPOUILLEE (commentaires et chaines blanchis) : un `class X`
    # ou une methode en commentaire leurrait le choix de la classe principale, la liste des
    # typeof du serveur et les bouchons. Le fichier depose, lui, reste l original.
    extraction = cs_canonical_types(cs_strip_comments(student_source))
    method_list = cs_signatures(extraction)
    harness = harness_rpc_body(case_dir) or ""
    klass = cs_student_class(extraction, harness)
    ctors, instance = cs_object_api(extraction, klass)
    # Une question POO n'a AUCUNE méthode statique : son API, c'est le constructeur et les
    # méthodes d'instance. Exiger une statique refusait ces questions (dont celles de la démo).
    # Le contrôle porte sur le CODE SOUMIS SEUL, jamais sur la classe que le harnais désigne :
    # le harnais d'un canari ne nomme aucune classe, donc le canari visait `Solution` (souvent
    # un simple Main) et était refusé, alors que le vrai cas visant `Rectangle` passait —
    # « falsification probable » sur une réponse juste. Même critère pour tous les cas.
    if not (method_list or cs_has_object_api(extraction)):
        return None, ("Aucune méthode exploitable dans le code soumis : ni méthode statique, "
                      "ni constructeur avec méthode d'instance (types acceptés : int, long, "
                      "double, bool, string).")
    harness = harness_rpc_body(case_dir) or ""

    lock_src_dir(case_dir)
    build_area = student_build_dir(case_dir)
    student_src = os.path.join(build_area, "serveur.cs")
    grader_src = os.path.join(case_dir, "noteur.cs")
    student_copy = os.path.join(build_area, "solution_etu.cs")
    with open(student_copy, "w", encoding="utf-8") as f:
        f.write(student_source)
    with open(student_src, "w", encoding="utf-8") as f:
        f.write(cs_server_source(cs_student_classes(extraction, harness),
                                 cs_namespaces(extraction)))
    for fpath in (student_copy, student_src):
        set_owner_mode(fpath, STUDENT_UID, STUDENT_GID, 0o600)
    write_private(grader_src, cs_grader_source(method_list, harness, TOKENS.get(case_index) or "",
                                           klass, ctors, instance))
    student_bin = os.path.join(build_area, "etu.exe")
    grader_bin = os.path.join(case_dir, "noteur.exe")
    # C# n'a pas d'inclusion textuelle a la compilation, mais le serveur est compile AVEC le
    # code soumis : meme regime que les autres — sous l'UID etudiant, dans son chantier.
    for cmd, label, cwd_c, env_c, preexec_c in (
            (["mcs", "-main:MooditServer", "-out:" + student_bin, student_src, student_copy],
             "code soumis", build_area, student_build_env(build_area), preexec_student_compile),
            (["mcs", "-main:MooditGrader", "-out:" + grader_bin, grader_src],
             "harnais", case_dir, env, preexec_compile)):
        code, expired = run_proc(cmd, cwd_c, env_c, COMPILE_TIMEOUT_S,
                                os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                                preexec_c)
        if expired or code != 0:
            detail = (read_capped(os.path.join(case_dir, "cc.err"))
                      or read_capped(os.path.join(case_dir, "cc.out")))[:1500]
            if label == "harnais":
                return None, harness_build_failure(expired, code, "contre le code soumis", detail)
            return None, "Échec de compilation :\n" + detail
    set_owner_mode(student_copy, STUDENT_UID, STUDENT_GID, 0o600)   # dans SON chantier
    return finish_rpc_pair(case_dir, env, timeout_s, case_index,
                           grader_src, grader_bin, student_src, student_bin,
                           grader_cmd=["mono", grader_bin], student_cmd=["mono", student_bin])


def run_rust_rpc(case_dir, env, timeout_s, case_index):
    """Notation NON FALSIFIABLE d'un cas Rust : harnais booléen, deux binaires, deux UID.

    Le harnais n'est plus dans le MÊME FICHIER que le code étudiant : `include_str!` n'a plus
    rien à inclure, et il n'y a plus de nonce dans ce processus."""
    src = os.path.join(case_dir, "src")
    student_source = ""
    for ident in sorted(os.listdir(src)):
        if ident == "solution.rs":
            with open(os.path.join(src, ident), "r", encoding="utf-8", errors="replace") as f:
                student_source = f.read()
    extraction = blank_code(student_source, rust=True)
    method_list = rust_signatures(extraction)
    obj_list = rust_object_api(extraction)
    # Source NETTOYEE, comme les signatures : lue brute, une virgule ou une fin de ligne
    # dans un commentaire de champ faisait perdre des champs, et le litteral du harnais
    # ne compilait plus.
    field_list = rust_capture_fields(extraction)
    if not (method_list or obj_list):
        return None, ("Aucune fonction exploitable dans le code soumis (types acceptés : i32, "
                      "i64, f64, bool, String).")
    harness = harness_rpc_body(case_dir) or ""

    lock_src_dir(case_dir)
    build_area = student_build_dir(case_dir)
    student_src = os.path.join(build_area, "etu.rs")
    grader_src = os.path.join(case_dir, "noteur.rs")
    with open(student_src, "w", encoding="utf-8") as f:
        f.write(rust_server_source(method_list, student_source, obj_list, field_list))
    set_owner_mode(student_src, STUDENT_UID, STUDENT_GID, 0o600)
    write_private(grader_src,
                 rust_grader_source(method_list, harness, TOKENS.get(case_index) or "", obj_list, field_list))
    student_bin = os.path.join(build_area, "etu_bin")
    grader_bin = os.path.join(case_dir, "noteur_bin")
    # Compilation etudiante sous SON UID, dans SON chantier : `include_str!("noteur.rs")`
    # embarquait harnais et nonce quand rustc tournait en root a cote du noteur.
    for source, out_value, label, cwd_c, env_c, preexec_c in (
            (student_src, student_bin, "code soumis", build_area, student_build_env(build_area),
             preexec_student_compile),
            (grader_src, grader_bin, "harnais", case_dir, env, preexec_compile)):
        code, expired = run_proc(["rustc", "-O", "--edition", "2021", source, "-o", out_value],
                                cwd_c, env_c, COMPILE_TIMEOUT_S,
                                os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                                preexec_c)
        if expired or code != 0:
            detail = read_capped(os.path.join(case_dir, "cc.err"))[:1500]
            if label == "harnais":
                return None, harness_build_failure(expired, code, "contre le code soumis", detail)
            return None, "Échec de compilation :\n" + detail
    return finish_rpc_pair(case_dir, env, timeout_s, case_index,
                           grader_src, grader_bin, student_src, student_bin)


def rpc_verdict(tok, g_err, s_err):
    """Verdict d'un cas noté par le COUPLE noteur/étudiant. FONCTION PURE (testée).

    Le nonce du cas n'est détenu que par le noteur, qui ne l'émet sur SON stderr que si le harnais
    du prof a renvoyé vrai : sans nonce, échec (fail-closed), y compris si le noteur a planté ou
    si aucun jeton n'a été armé. Le détail privilégie le message du NOTEUR — c'est lui qui sait
    pourquoi le harnais a échoué ; le stderr de l'étudiant ne vient qu'ensuite, et il est choisi
    par lui, donc jamais présenté comme la cause."""
    # LIGNE EXACTE, pas une sous-chaine : les noteurs relaient des messages d erreur dont le
    # texte vient de l etudiant — en sous-chaine, toute fuite du nonce devenait un « reussi »
    # des que ce texte le contenait. Le noteur emet le nonce encadre de sauts de ligne, et les
    # relais remplacent \n/\r par des espaces : un texte relaye ne peut pas fabriquer de ligne.
    passed = bool(tok) and any(
        src_line.rstrip(chr(13)) == tok for src_line in (g_err or "").split(chr(10)))
    if passed:
        return True, None
    detail = (first_lines(g_err or "", r"^\[MOODIT\]")
              or first_lines(s_err or "", r".")
              or "Le harnais a renvoyé faux")
    return False, detail


def finish_rpc_pair(case_dir, env, timeout_s, case_index, grader_src, grader_bin, student_src, student_bin,
                    grader_cmd=None, student_cmd=None):
    """Cloisonne les deux programmes, les lance en couple, rend le verdict.

    Partie COMMUNE à C/C++ et Rust (et à tout langage dont le noteur est un binaire) : chacun
    chez soi en 700 sous son UID, puis le nonce du noteur fait le verdict."""
    lock_sources(os.path.join(case_dir, "src"))
    for fpath, uid, mode in ((grader_src, grader_uid(), 0o600), (grader_bin, grader_uid(), 0o500),
                              (student_src, STUDENT_UID, 0o600), (student_bin, STUDENT_UID, 0o500)):
        if os.path.isdir(fpath) and not os.path.islink(fpath):
            # Go travaille par MODULE : on cloisonne le dossier entier, récursivement.
            set_owner_mode_tree(fpath, uid, uid, 0o600, 0o700)
            continue
        # Sans suivre de lien : etu_src et bin_etu vivent dans le chantier de l'etudiant.
        set_owner_mode(fpath, uid, uid, mode)
    prep_run(case_dir, os.path.join(case_dir, "src"))
    work = os.path.join(case_dir, "work")
    os.makedirs(work, exist_ok=True)
    os.chmod(work, 0o755)
    student_tmp = student_dir(work, "tmp")
    grader_tmp = grader_dir(case_dir, "noteur_tmp")
    code, expired, g_err, s_err = run_pair(
        grader_cmd or [grader_bin], student_cmd or [student_bin], case_dir,
        dict(env, HOME=grader_tmp, TMPDIR=grader_tmp), dict(env, HOME=student_tmp, TMPDIR=student_tmp),
        timeout_s, os.path.join(case_dir, "grader.err"), os.path.join(case_dir, "student.err"))
    if expired:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    passed, detail = rpc_verdict(TOKENS.get(case_index) or "", g_err, s_err)
    # Noteur MORT PAR SIGNAL (OOM...) : cause NON CONCLUANTE. Sans ce marquage, un canari
    # « pass » tue par manque de memoire passait pour un canari en echec, et faisait
    # accuser de falsification une soumission dont un vrai cas avait reussi.
    grader_dead = grader_killed(code, passed)
    return CaseOutcome(passed, detail, ran=True, killed=grader_dead), None


def run_c_rpc(case_dir, env, timeout_s, case_index, compiler, std, ext):
    """Notation NON FALSIFIABLE d'un cas C/C++ : harnais booléen, deux binaires, deux UID.

    Le harnais n'est plus inclus dans l'unité de compilation du code étudiant : un
    `#define printf …` ne capture plus rien, et il n'y a plus de nonce à intercepter dans ce
    processus — c'est le résiduel in-process de C/C++ qui disparaît, pas qui se détecte."""
    src = os.path.join(case_dir, "src")
    student_source = ""
    for ident in sorted(os.listdir(src)):
        if ident.startswith("solution.") :
            with open(os.path.join(src, ident), "r", encoding="utf-8", errors="replace") as f:
                student_source = f.read()
    extraction = blank_code(student_source)
    obj_list = cpp_object_api(extraction) if ext == "cpp" else []
    method_list = c_signatures(extraction, cpp=(ext == "cpp"))
    if not (method_list or obj_list):
        return None, ("Aucune fonction exploitable dans le code soumis "
                      "(types acceptés : int, long, double).")
    harness = harness_rpc_body(case_dir) or ""
    # Refus AVANT toute compilation : une fonction soumise au nom d'une fonction ou d'une macro
    # de la bibliotheque standard fournie au harnais (fabs, sqrt, isnan, abs, true…) prendrait
    # sa place dans le harnais (voir c_grader_source).
    reserved = c_reserved_names([ident for _, ident, _ in method_list], compiler, std, case_dir, env)
    if reserved:
        return None, reserved_name_message(
            reserved, "la bibliothèque standard (math.h, stdbool.h, stdio.h, stdlib.h, string.h)")

    lock_src_dir(case_dir)
    build_area = student_build_dir(case_dir)
    student_src = os.path.join(build_area, "etu." + ext)
    grader_src = os.path.join(case_dir, "noteur." + ext)
    with open(student_src, "w", encoding="utf-8") as f:
        f.write(c_server_source(method_list, student_source, cpp=(ext == "cpp"), obj_list=obj_list))
    set_owner_mode(student_src, STUDENT_UID, STUDENT_GID, 0o600)
    write_private(grader_src, c_grader_source(method_list, harness, TOKENS.get(case_index) or "",
                                          cpp=(ext == "cpp"), obj_list=obj_list))
    student_bin = os.path.join(build_area, "etu_bin")
    grader_bin = os.path.join(case_dir, "noteur_bin")
    # Le code soumis est compile SOUS L'UID ETUDIANT, dans un chantier qui ne contient que
    # lui : compile par root a cote du noteur, un `.incbin`/`#include` embarquait harnais et
    # nonce dans le binaire note. Le noteur, lui, reste compile par root — aucune ligne
    # etudiante n'y entre.
    for source, out_value, label, cwd_c, env_c, preexec_c in (
            (student_src, student_bin, "code soumis", build_area, student_build_env(build_area),
             preexec_student_compile),
            (grader_src, grader_bin, "harnais", case_dir, env, preexec_compile)):
        # -fno-builtin : `abs`, `sqrt`… sont des fonctions INTEGREES de gcc, calculees a la
        # compilation (abs(-5) devient 5) sans appeler la fonction notee du meme nom — une
        # reponse fausse passait. Les deux programmes, pour que chacun appelle la vraie.
        code, expired = run_proc([compiler, std, "-O1", "-fno-builtin", source, "-o", out_value, "-lm"],
                                cwd_c, env_c, COMPILE_TIMEOUT_S,
                                os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                                preexec_c)
        if expired or code != 0:
            detail = read_capped(os.path.join(case_dir, "cc.err"))[:1500]
            if label == "harnais":
                return None, harness_build_failure(expired, code, "contre le code soumis", detail)
            return None, "Échec de compilation :\n" + detail

    return finish_rpc_pair(case_dir, env, timeout_s, case_index,
                           grader_src, grader_bin, student_src, student_bin)


def run_go_rpc(case_dir, env, timeout_s, case_index):
    """Notation NON FALSIFIABLE d'un cas Go : harnais booléen, deux binaires, deux UID."""
    src = os.path.join(case_dir, "src")
    student_mod = os.path.join(case_dir, "etu")
    grader_src_dir = os.path.join(case_dir, "noteur")
    for d in (student_mod, grader_src_dir):
        os.makedirs(d, exist_ok=True)

    student_source = ""
    for ident in sorted(os.listdir(src)):
        if ident.endswith(".go") and ident != "go.mod":
            with open(os.path.join(src, ident), "r", encoding="utf-8", errors="replace") as f:
                body_text = f.read()
            if "__MOODIT_HARNAIS__" not in body_text and "_test.go" not in ident:
                student_source = body_text
    extraction = blank_code(student_source, backticks=True)
    method_list = go_signatures(extraction)
    obj_list = go_object_api(extraction)
    # Source NETTOYEE : commentaires et etiquettes `json:"x"` effaces, comme pour les
    # signatures — lue brute, une etiquette faisait perdre toute la structure.
    field_list = go_capture_fields(extraction)
    if not (method_list or obj_list):
        return None, ("Aucune fonction exploitable dans le code soumis (types acceptés : int, "
                      "int64, float64, bool, string).")
    harness = harness_rpc_body(case_dir) or ""
    # Les bouchons du noteur portent le nom exact des fonctions soumises, au niveau du paquet :
    # une `func max(a, b int) int` soumise y masquait la fonction INTEGREE `max` du harnais.
    # Meme chose pour les NOMS DE TYPE et les CONSTRUCTEURS de l'API objet, eux aussi declares
    # au niveau du paquet du noteur (`type string struct{}`, `func recover() *T`). Les methodes,
    # rattachees a leur type, ne masquent rien.
    reserved = go_reserved_names([ident for _, ident, _ in method_list]
                                 + [name for type_name, ctors, _ in obj_list
                                    for name in [type_name] + [c[0] for c in ctors]])
    if reserved:
        return None, reserved_name_message(reserved, "le langage Go (identifiant prédéclaré)")
    packages = go_harness_package_names([ident for _, ident, _ in method_list]
                                        + [name for type_name, ctors, _ in obj_list
                                           for name in [type_name] + [c[0] for c in ctors]])
    if packages:
        return None, reserved_name_message(packages, "un paquet Go importé pour le harnais")

    # Deux modules Go indépendants : le harnais n'est NI compilé avec le code étudiant, NI
    # présent dans l'arborescence que son processus peut lire.
    with open(os.path.join(student_mod, "go.mod"), "w", encoding="utf-8") as f:
        f.write("module moodit_etu\n\ngo 1.23\n")
    with open(os.path.join(student_mod, "solution.go"), "w", encoding="utf-8") as f:
        f.write(go_student_without_main(student_source))
    with open(os.path.join(student_mod, "serveur.go"), "w", encoding="utf-8") as f:
        f.write(go_server_source(method_list, obj_list, field_list))
    write_private(os.path.join(grader_src_dir, "go.mod"), "module moodit_noteur\n\ngo 1.23\n")
    write_private(os.path.join(grader_src_dir, "noteur.go"),
                 go_grader_source(method_list, harness, TOKENS.get(case_index) or "", obj_list, field_list))
    os.chmod(grader_src_dir, 0o700)

    # Le module ETUDIANT lui appartient, et son build tourne sous SON UID avec CGO coupe : en
    # root avec cgo actif (la parade du Dockerfile etait perdue par le env= de Popen), un
    # preambule cgo embarquait ../noteur/noteur.go — harnais et nonce — dans le binaire note.
    lock_src_dir(case_dir)
    build_area = student_build_dir(case_dir)
    chown_tree(student_mod, STUDENT_UID, STUDENT_GID)
    os.chmod(student_mod, 0o700)
    student_bin = os.path.join(student_mod, "etu_bin")
    grader_bin = os.path.join(case_dir, "noteur_bin")
    for directory, out_value, label, env_c, preexec_c in (
            (student_mod, student_bin, "code soumis", student_build_env(build_area), preexec_student_compile),
            (grader_src_dir, grader_bin, "harnais", env, preexec_compile)):
        code, expired = run_proc(["go", "build", "-o", out_value, "."], directory, env_c,
                                COMPILE_TIMEOUT_S, os.path.join(case_dir, "cc.out"),
                                os.path.join(case_dir, "cc.err"), preexec_c)
        if expired or code != 0:
            detail = read_capped(os.path.join(case_dir, "cc.err"))[:1500]
            if label == "harnais":
                return None, harness_build_failure(expired, code, "contre le code soumis", detail)
            return None, "Échec de compilation :\n" + detail

    return finish_rpc_pair(case_dir, env, timeout_s, case_index,
                           grader_src_dir, grader_bin, student_mod, student_bin)


RUNNERS = {
    "c": run_c,
    "cpp": run_cpp,
    "java": run_java,
    "csharp": run_csharp,
    "go": run_go,
    "rust": run_rust,
}


def substitute_placeholders(case_dir, mapping):
    """Remplace les gabarits des canaris (__MOODIT_A__/__MOODIT_B__) dans les sources du cas
    par les valeurs tirées au sort. Le NONCE, lui, ne passe jamais par une source."""
    for root, _, files in os.walk(os.path.join(case_dir, "src")):
        for name in files:
            # Le HARNAIS seulement : le fichier etudiant n'est jamais reecrit (defense en
            # profondeur — un code contenant __MOODIT_ est deja refuse en amont).
            if not name.startswith("harnais_rpc."):
                continue
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
    # État de capture NEUF pour ce cas (voir ExitState : une pompe retardataire du cas
    # précédent ne doit pas désarmer la détection ici).
    global EXIT_STATE
    EXIT_STATE = ExitState(case["index"])
    case_dir = os.path.join(BOX, "cases", str(case["index"]))
    runner = RUNNERS[language]
    env = base_env(case_dir)
    os.makedirs(env["HOME"], exist_ok=True)
    os.makedirs(env["TMPDIR"], exist_ok=True)
    start = time.monotonic()
    outcome, compile_error = runner(case_dir, env, timeout_s, case["index"])
    elapsed_ms = int((time.monotonic() - start) * 1000)
    if compile_error is not None:
        # Le préfixe est NOTRE texte (le message du compilateur ne vient qu'après) : le code
        # soumis ne peut pas le produire.
        outcome = CaseOutcome(False, compile_error, ran=False,
                              harness_build=is_harness_build_failure(compile_error))
    if EXIT_STATE.killed_by_signal and not outcome.passed:
        outcome.killed = True
    if EXIT_STATE.expired and not outcome.passed:
        # Vaut aussi pour une COMPILATION expirée, que les runners rapportent en simple
        # « Échec de compilation » : c'est une cause NON CONCLUANTE, pas un sabotage.
        outcome.timed_out = True
    if EXIT_STATE.lost and not outcome.passed:
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
        # -safe : coupe .shell/.system/.read/.import/.output, ATTACH, readfile/writefile… Le
        # programme arrive par STDIN, ouvert par root sur un fichier root 0600 (cf.
        # exec_main) : il porte les sentinelles au nonce, et la table virtuelle fsdir, que
        # -safe laisse passer, lisait encore main.sql quand l'étudiant en était propriétaire.
        return None, ["sqlite3", "-safe", "-bail", "-batch", ":memory:"]
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
        # Même édition que la notation : sans --edition, rustc compile en 2015, et un code
        # accepté à la notation pouvait échouer au bouton « Exécuter ».
        return ["rustc", "-O", "--edition", "2021", entry, "-o", "prog"], ["./prog"]
    return None, None


# Taille ECHAPPEE maximale d'une sortie : le double du plafond en caracteres, car un texte
# ordinaire s'echappe au plus en double (saut de ligne, guillemet, barre oblique inverse) et doit
# passer INTACT — un dump SQL de la phase 1 en depend. Seuls les caracteres de controle
# (6 octets chacun) peuvent depasser.
EXEC_JSON_CAP = 2 * EXEC_OUTPUT_CAP + 1024


def bound_json(src_text, ceiling=EXEC_JSON_CAP):
    """Borne la taille ECHAPPEE d'une sortie, telle qu'elle partira dans le JSON. PURE (testee).

    read_capped borne les CARACTERES ; mais un caractere de controle s'echappe en six octets
    (\\u0001) : une sortie qui en est pleine faisait six fois le plafond, deux sorties par
    etape, et execution-service (256 Mo de tas en prod) relisait le tout en memoire. Au-dela du
    plafond, on garde la TETE et la QUEUE, comme read_capped : la queue porte les verdicts."""
    if len(json.dumps(src_text, ensure_ascii=False)) <= ceiling:
        return src_text
    keep_chars = max(ceiling // 12 - 64, 0)   # pire cas : 6 octets par caractere, tete + queue
    return (src_text[:keep_chars] + "\n… (sortie tronquée au milieu : trop de caractères de contrôle)\n"
            + (src_text[-keep_chars:] if keep_chars else ""))


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
    return {"stdout": bound_json(read_capped(out_path, EXEC_OUTPUT_CAP)),
            "stderr": bound_json(read_capped(err_path, EXEC_OUTPUT_CAP)),
            "code": code, "signal": signal_name}


def exec_env(work):
    env = dict(base_env(BOX))
    env["HOME"] = os.path.join(work, "home")
    env["TMPDIR"] = os.path.join(work, "tmp")
    env["GOCACHE"] = os.path.join(work, "gocache")
    env["GOPATH"] = os.path.join(work, "gopath")
    env["CARGO_TARGET_DIR"] = os.path.join(work, "target")
    return env


def exec_output_dir():
    """Dossier des sorties capturées du mode exec : à root, hors de tout dossier étudiant."""
    return os.path.join(BOX, ".sorties")


def exec_main(job):
    src = os.path.join(BOX, "src")
    work = os.path.join(BOX, "work")
    for name in ("home", "tmp"):
        os.makedirs(os.path.join(work, name), exist_ok=True)
    # Tout le job est non fiable : sources possédées par l'étudiant (le grader s'auto-supprime).
    for root, dirs, files in os.walk(BOX):
        for name in dirs + files:
            os.chown(os.path.join(root, name), STUDENT_UID, STUDENT_GID)
    # /box lui-même reste à ROOT (0755), et les sorties capturées vivent dans un dossier root
    # 0700 : root les relit PAR LEUR CHEMIN (exec_stage). Posées dans /box/work, qui appartient à
    # l'étudiant, le code exécuté pouvait effacer run.err pendant son exécution et en créer un à
    # lui à la place — root écrivait dans l'ancien inode et relisait le nouveau, donc une sortie
    # choisie par le code noté (un nonce lu ailleurs suffisait alors à passer).
    os.chown(BOX, 0, 0)
    os.chmod(BOX, 0o755)
    outputs = exec_output_dir()
    os.makedirs(outputs, exist_ok=True)
    os.chown(outputs, 0, 0)
    os.chmod(outputs, 0o700)

    runtime = job.get("runtime", "")
    entry = job.get("entry", "")
    compile_cmd, run_cmd = exec_commands(runtime, entry)
    if run_cmd is None:
        print(json.dumps({"v": 1, "error": "runtime non pris en charge : " + runtime}))
        return
    env = exec_env(work)

    stdin_path = None
    if runtime == "sqlite3":
        # Le programme SQL porte les sentinelles au nonce : il doit rester ILLISIBLE pour le
        # code soumis, qui tourne dans le même processus sqlite3 (sous l'UID étudiant). Root
        # le verrouille en 0600 AVANT tout lancement, puis l'ouvre lui-même comme stdin
        # (run_proc) : le processus reçoit le descripteur sans pouvoir rouvrir le fichier.
        # Le stdin éventuel du job est ignoré : pour SQL, stdin EST le programme.
        stdin_path = os.path.join(src, entry)
        set_owner_mode(stdin_path, 0, 0, 0o600)
    elif job.get("stdin"):
        stdin_path = os.path.join(BOX, "stdin.txt")
        with open(stdin_path, "w", encoding="utf-8") as f:
            f.write(job["stdin"])
        os.chown(stdin_path, STUDENT_UID, STUDENT_GID)

    compile_stage = None
    if compile_cmd is not None:
        code, timed_out = run_proc(compile_cmd, src, env, EXEC_COMPILE_TIMEOUT_S,
                                   os.path.join(outputs, "cc.out"), os.path.join(outputs, "cc.err"),
                                   demote_student)
        compile_stage = exec_stage(code, timed_out, os.path.join(outputs, "cc.out"),
                                   os.path.join(outputs, "cc.err"))
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
                               os.path.join(outputs, "run.out"), os.path.join(outputs, "run.err"),
                               demote_student, stdin_path=stdin_path)
    run_stage = exec_stage(code, timed_out, os.path.join(outputs, "run.out"),
                           os.path.join(outputs, "run.err"))
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
    # job.json porte le code de TOUS les harnais (cas caches compris) : il est DEPLACE ici par
    # wait_for_files avec les perms du tar, donc potentiellement lisible. On le ferme MAINTENANT,
    # root l'ayant deja lu. Meme chose pour l'arbre des cas, par securite.
    try:
        os.chown(os.path.join(BOX, "job.json"), 0, 0)
        os.chmod(os.path.join(BOX, "job.json"), 0o600)
    except OSError:
        pass
    if job.get("mode") == "exec":
        exec_main(job)
        return
    # Mode NOTATION seulement (le mode exec donne /box a l'etudiant, et root n'y repasse pas).
    # /box est un tmpfs monte en 1777 : l'etudiant pouvait y poser `/box/cargo -> /`, et root le
    # suivait au cas suivant. Rien n'y a besoin d'ecrire a la racine hors root (les dossiers
    # etudiants sont crees puis donnes par root) : 0755.
    os.chown(BOX, 0, 0)
    os.chmod(BOX, 0o755)
    language = job["language"]
    if language not in RUNNERS:
        print(json.dumps({"v": 1, "error": "langage non pris en charge : " + language}))
        return
    if language == "go":
        # Dossiers de build ETUDIANTS, Go seulement : le compilateur du code soumis tourne sous
        # son UID. Créés pour tous les langages, ils étaient un point d'écriture de l'étudiant
        # jamais vidé, hors de cases/.
        reset_go_student_dirs()
    timeout_s = max(1, min(MAX_RUN_TIMEOUT_S,
                           int(job.get("timeout_ms") or DEFAULT_RUN_TIMEOUT_S * 1000) // 1000))
    if language in ("java", "csharp"):
        # Plancher VM, symétrique du mode exec : JVM + ConsoleLauncher (ou mono + NUnitLite)
        # mettent couramment 2 à 5 s à démarrer — un temps limite court mais légitime du prof
        # (1-5 s) tuait sinon TOUS les cas, canaris compris → « falsification probable » à tort.
        timeout_s = max(timeout_s, 10)

    cases = job["cases"]
    # Canaris et NONCES : valeurs tirées MAINTENANT (imprévisibles), ordre d'exécution mélangé.
    # Le nonce ne va JAMAIS dans une source : il est passé au générateur du noteur, qui le
    # compile dans SON programme — celui où aucun code soumis ne tourne. Un code soumis ne peut
    # donc pas le lire, et ne peut pas produire la seule chose qui vaut réussite.
    rng = random.SystemRandom()
    for case in cases:
        case_dir = os.path.join(BOX, "cases", str(case["index"]))
        TOKENS[case["index"]] = str(rng.randrange(10**12, 10**13))
        subst = {}
        if case.get("canary") == "pass":
            a = rng.randrange(100000, 999999)
            subst.update({"__MOODIT_A__": str(a), "__MOODIT_B__": str(a)})
        elif case.get("canary") == "fail":
            a = rng.randrange(100000, 999999)
            subst.update({"__MOODIT_A__": str(a),
                          "__MOODIT_B__": str(a + 1 + rng.randrange(1000))})
        substitute_placeholders(case_dir, subst)
    # Verrou de TOUS les src/ AVANT le premier cas : chaque cas ne verrouillait que le sien a
    # son tour, donc un cas en cours pouvait lire le harnais des AUTRES cas — cas caches
    # compris. root lit toujours a travers (il construit chaque noteur), le processus etudiant
    # recoit EACCES. Le verrou par cas reste, en defense en profondeur.
    for case in cases:
        lock_src_dir(os.path.join(BOX, "cases", str(case["index"])))
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
    total_canaries = sum(1 for c in cases if c.get("canary"))
    pending_canaries = total_canaries

    for case in order:
        if case.get("canary"):
            pending_canaries -= 1   # à partir d'ici, ce canari ne réclame plus sa part
        if box_exhausted():
            # Espace de travail saturé (par un cas précédent, ou par la copie du job) : rien
            # à reprocher à l'étudiant, et surtout pas une falsification — un cas « sauté »
            # n'entre pas dans le verdict des canaris.
            outcomes[case["index"]] = CaseOutcome(
                False, "Espace de travail saturé : le code écrit trop de fichiers "
                       "(ou des fichiers trop gros) dans son dossier temporaire.",
                ran=False, skipped=True, cause="espace")
            timings[case["index"]] = 0
            event("espace_sature", case=case["index"])
            continue
        # Un cas réel doit laisser intacte la réserve des canaris PAS ENCORE exécutés ; un
        # canari puise dedans.
        case_deadline = deadline
        if deadline is not None and not case.get("canary"):
            case_deadline = deadline - pending_canary_reserve(
                canary_reserve_s, total_canaries, pending_canaries)
        if case_deadline is not None and time.monotonic() >= case_deadline:
            outcomes[case["index"]] = CaseOutcome(
                False, "Non exécuté : budget de notation dépassé (trop de cas ou cas trop longs)",
                ran=False, skipped=True, cause="budget")
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
            # Seule une exception de LOGIQUE est « non imputable » (-> 502, tentative a
            # reprendre). Une OSError vient de l'ENVIRONNEMENT — disque, liens, processus — que
            # l'etudiant partage et peut provoquer : en faire un 502 lui offrait un reessai a
            # volonte. Elle reste skipped (aucune accusation de falsification), mais elle note.
            environmental = exception_cause(e) == "environnement"
            outcome, ms = CaseOutcome(
                False,
                ("Notation impossible : espace de travail épuisé ou modifié par le code soumis"
                 if environmental else "Erreur interne du noteur"),
                ran=False, skipped=True,
                cause="environnement" if environmental else "erreur"), 0
            event("erreur_superviseur", case=case["index"], detail=repr(e))
        outcomes[case["index"]] = outcome
        timings[case["index"]] = ms
        # Isolation inter-cas : un processus étudiant qui a fait fork + setsid a quitté le
        # groupe tué au timeout — il survivrait au cas et pourrait peser sur (voire tracer,
        # même UID) les cas suivants. Balayage de TOUT processus UID étudiant entre deux cas.
        kill_student_survivors()
        purge_shared_dirs()
        if language == "go":
            # GOPATH étudiant vidé à chaque cas (aucune dépendance : il ne sert à rien d'un cas
            # à l'autre). Le GOCACHE est gardé : le vider recompilerait la bibliothèque standard
            # à chaque cas. Le code soumis peut y écrire, mais n'y nuit qu'à SA propre note (cas
            # suivants sautés, cause « espace ») : il ne peut pas y forger de verdict.
            reset_go_student_dirs(keep_cache=True)
        # Le tmpfs /box est compté dans la MÉMOIRE du conteneur : les artefacts de build du cas
        # (target cargo ~50-100 Mo, HOME/TMP de compilation) ne servent plus après son verdict —
        # les accumuler faisait saturer une question Rust à beaucoup de cas (ENOSPC déguisé en
        # « Échec de compilation », voire OOM). Le gocache partagé, lui, sert aux cas suivants.
        # Le cas est noté : TOUT son répertoire est libéré, work/ compris (HOME et TMPDIR de
        # l'étudiant — ses seuls points d'écriture). Ne libérer que les caches de build laissait
        # un code qui écrit des fichiers saturer le tmpfs /box, partagé par tous les cas : les
        # suivants ne compilaient plus, canaris inclus, et la soumission — honnête mais boguée —
        # était étiquetée « falsification probable ». Seule exception : le GOCACHE étudiant (Go
        # seulement, hors cases/), gardé d'un cas à l'autre (voir reset_go_student_dirs).
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

    # Un verdict de FALSIFICATION l'emporte : des canaris incoherents ne doivent jamais devenir
    # une tentative a reprendre, meme si un cas a aussi subi une erreur interne.
    incomplete = job_incomplete(
        canaries, (outcomes[c["index"]] for c in cases if not c.get("canary")))
    print(json.dumps({"v": 1, "results": results, "events": EVENTS, "canaries": canaries,
                      "incomplet": incomplete},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
