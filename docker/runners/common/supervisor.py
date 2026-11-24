#!/usr/bin/env python3
"""Superviseur de notation MoodIT (#116) — processus de CONFIANCE du conteneur runner.

Tourne en root dans un conteneur jetable (réseau coupé, /box et /tmp en tmpfs bornés — seuls
points d'écriture de l'UID étudiant, les images verrouillant leurs répertoires monde-inscriptibles).
Le code étudiant, lui, ne tourne JAMAIS en root : chaque cas est exécuté sous l'UID `student`,
le harnais du prof tournant dans un AUTRE processus (le noteur), sources verrouillées en 700 root.

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
    assemblé embarque sa propre protection : nonce, auto-suppression), compilation comprise
    pour les langages qui en ont une (preexec_student_compile : jamais root, le compilateur
    obéit à un texte choisi par l'étudiant). /box reste root 0755 ; les sorties sont écrites
    dans /box/.sorties (root, 0700). Sortie : {compile?, run} à la Piston.

Entrée  : job.json + les sources, copiés par execution-service AVANT le démarrage dans
          /opt/moodit/staging (sentinelle .ready en dernier), puis déplacés ici dans le
          tmpfs /box par wait_for_files().
Sortie  : UN objet JSON sur stdout.
Le protocole côté Java vit dans execution-service/…/sandbox/ ; garder les deux en phase.
"""

import bisect
import collections
import functools
import hashlib
import json
import os
import random
import re
# `resource` est POSIX : absent sous Windows, l environnement de dev du projet. Les
# fonctions qui posent des rlimits ne tournent que DANS le conteneur (Linux) ; proteger
# l import permet de rejouer les tests unitaires du superviseur en local, sans Docker.
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

BOX = "/box"
STUDENT_NAME = "student"
# UID/GID de l'étudiant : valeurs des images, RANDOMISÉES au démarrage par
# randomize_student_uid() — voir sa docstring (RLIMIT_NPROC est un budget PARTAGÉ entre
# conteneurs quand l'UID est le même).
STUDENT_UID = 1300
STUDENT_GID = 1300
# Plage du tirage (bornes [début, fin[) : fin − 1 est le dernier UID étudiant, et le noteur prend
# UID + 1 — d'où le « − 2 », qui garde les deux sous 2³¹ (aucun outil ne les lit signés).
STUDENT_UID_RANGE = (1 << 24, (1 << 31) - 2)
READY_WAIT_S = 30
COMPILE_TIMEOUT_S = 90
LIST_TIMEOUT_S = 5              # inventaire `--list` : s'ajoute au pire cas, donc borné court
JAVAP_CAP = 2 * 1024 * 1024     # sortie de javap relue en entier jusqu'à 2 Mio (cf. run_java_rpc)
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


# Ligne écrite sur le stderr du superviseur JUSTE AVANT qu'il prenne en charge le code soumis
# (#116, plafond des échecs sans verdict). execution-service la cherche quand le superviseur meurt
# sans rendre de JSON : absente, il est mort pendant sa propre mise en place (image cassée, job
# non reçu, version incompatible) — panne de plateforme, non comptée contre l'étudiant ;
# présente, le code soumis a pu y jouer un rôle. Le code soumis ne peut pas l'effacer : ses
# sorties vont dans des tubes et des fichiers, jamais sur le stderr du PID 1.
SUBMITTED_CODE_STAGE = "moodit-supervisor: submitted-code-stage"


def announce_submitted_code_stage():
    log(SUBMITTED_CODE_STAGE)


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
    et on le signale dans les logs.

    Plage LARGE (STUDENT_UID_RANGE) : tirés parmi 40 000 valeurs, deux conteneurs simultanés
    partageaient un UID (étudiant ou noteur, qui vaut UID + 1) environ 4 fois sur 10 000 avec
    trois places — et toutes les limites par UID de l'hôte avec lui (RLIMIT_NPROC, mesuré : le
    second conteneur ne pouvait même plus lancer bash). Parmi deux milliards, c'est de l'ordre
    de 10⁻⁸. La plage commence au-dessus des sous-UID usuels (/etc/subuid, 100000 + 65536 × n)."""
    global STUDENT_UID, STUDENT_GID
    uid = random.SystemRandom().randrange(*STUDENT_UID_RANGE)
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


# oom_score_adj des processus lancés par le superviseur (lui-même à -1000, cf. mark_oom_victim).
# Le CODE SOUMIS (exécution et compilation) est la PREMIÈRE victime ; le noteur des compilés et
# les processus root de preexec_compile (compilations du noteur, sonde des noms réservés, javap,
# compilation du serveur Java) passent après lui. En mode exec, le noteur assemblé tourne sous
# l'UID étudiant (demote_student) : même valeur, même filtre que le code soumis. Pourquoi deux
# niveaux : un noteur JVM pèse plus que de petits processus soumis, et à égalité c'est lui que
# l'OOM tuait — le cas échouait quand même, mais au lieu du processus fautif. Il reste tuable
# avant le superviseur.
OOM_ADJ_SUBMITTED = 1000
OOM_ADJ_TRUSTED = 500


def mark_oom_victim(score=OOM_ADJ_SUBMITTED):
    """Fait du processus courant une victime de l'OOM AVANT le superviseur, DÉFINITIVEMENT.
    Testée (POSIX).

    Le superviseur est le PID 1 du conteneur : si l'OOM le tue, le conteneur meurt sans JSON —
    panne, 502, tentative supprimée et rejouable à volonté. Il est donc lancé à -1000, « jamais
    tué » (DockerSandbox.SUPERVISOR_OOM_SCORE_ADJ), et CHAQUE processus qu'il lance — code
    soumis, noteur, compilations, javap/nm, aide de kill_student_uid, rm de remove_tree —
    passe par ici, et run_proc/run_pair l'appliquent d'office (oom_victim_first). Un enfant oublié hériterait de
    -1000 : intuable, il bloquerait l'OOM du cgroup au lieu d'être tué.

    IRRÉVERSIBLE : écrite par root qui DÉTIENT CAP_SYS_RESOURCE (DockerSandbox l'accorde au
    conteneur pour cette seule raison), la valeur relève aussi le plancher du processus
    (oom_score_adj_min) — hérité au fork, il interdit à tout descendant de la redescendre (EACCES
    dès 999, mesuré). Sans cette capacité, le code soumis pouvait la ramener à celle du PID 1, et
    tout objet noyau tenu par un petit processus vivant (tampons de sockets, memfd non projeté,
    VMA, epoll…) faisait tuer le superviseur. Le code soumis, lui, n'a aucune capacité : setuid
    les efface, no-new-privileges l'empêche d'en regagner.

    AVANT setuid : après, /proc/self appartient à root et l'écriture est refusée. Au mieux : sans
    /proc, rien ne change."""
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write(str(score))
    except OSError:
        pass


def oom_victim_first(preexec):
    """preexec_fn de TOUT lancement (run_proc, run_pair) : victime de l'OOM d'abord, puis le
    preexec propre au processus, qui peut abaisser à OOM_ADJ_TRUSTED (root détient
    CAP_SYS_RESOURCE). Un lancement futur sans preexec, ou avec un preexec qui oublie
    mark_oom_victim, ne peut donc plus garder le -1000 du superviseur."""
    def launch():
        mark_oom_victim()
        if preexec is not None:
            preexec()
    return launch


# ── Filtre seccomp des processus de l'UID étudiant ─────────────────────────────────────────
# Il s'ajoute au profil de Docker et refuse deux familles d'appels que ni le cgroup ni une limite
# par UID ne bornent :
#
# 1. Les verrous d'enregistrement POSIX (F_SETLK…, refusés en ENOLCK). Un verrou fcntl est un
#    objet noyau de ~216 octets que le cgroup NE COMPTE PAS (comptage retiré du noyau en 2021,
#    revert 3754707bcc3e ; vérifié sur 6.6) : 4 millions de verrous posés en 16 s par le code
#    soumis ajoutaient 872 Mo de mémoire noyau à l'HÔTE et 0 au conteneur. Un seul « Exécuter »
#    de 60 s suffisait à pousser le VPS de prod (8 Go, ~1 Go de marge) dans l'OOM GLOBAL, qui tue
#    alors le processus le plus lourd parmi les candidats à 1000 — souvent le code soumis d'un
#    AUTRE étudiant, dont la note devient fausse. Aucune limite du noyau ne borne leur nombre
#    (RLIMIT_LOCKS n'est plus appliquée). flock() et les baux — un objet par fichier ouvert, donc
#    bornés par RLIMIT_NOFILE × RLIMIT_NPROC : 31 248 au plus, 16 Mo d'hôte mesurés — restent
#    permis : flock est celui que les chaînes de compilation utilisent (cache de go build, mesuré).
# 2. L'AIO noyau (io_setup, refusé en ENOSYS, la réponse d'un noyau qui ne l'a pas). Sa limite,
#    fs.aio-max-nr, est GLOBALE à l'hôte : 128 contextes de 512 événements, pris en une seconde,
#    la vidaient pour tous les conteneurs. Aucun langage des images ne s'en sert.
LOCK_DENY_ERRNO = 37                       # ENOLCK
AIO_DENY_ERRNO = 38                        # ENOSYS
LOCK_COMMANDS = (6, 7, 37, 38)             # F_SETLK, F_SETLKW, F_OFD_SETLK, F_OFD_SETLKW
LOCK_COMMANDS_32 = (13, 14)                # F_SETLK64, F_SETLKW64 (ABI 32 bits)
# (AUDIT_ARCH_*, numéros de fcntl/fcntl64, ABI 32 bits ?, numéros de io_setup) ; x32 = numéro
# | 0x40000000 (son io_setup est le 543 : le 206 n'existe qu'en 64 bits).
STUDENT_FILTER_ARCHES = ((0xC000003E, (72, 0x40000000 | 72), False, (206, 0x40000000 | 543)),
                         (0xC00000B7, (25,), False, (0,)),                    # aarch64
                         (0x40000003, (55, 221), True, (245,)),               # i386 sur x86_64
                         (0x40000028, (55, 221), True, (243,)))               # arm sur aarch64
_BPF_LD_W_ABS, _BPF_JEQ_K, _BPF_RET_K = 0x20, 0x15, 0x06
SECCOMP_RET_ALLOW, SECCOMP_RET_ERRNO = 0x7FFF0000, 0x00050000


def student_filter_program():
    """Programme BPF du filtre étudiant : liste de (code, jt, jf, k). FONCTION PURE (testée).

    seccomp_data : nr à l'octet 0, arch à 4, args[1] (la commande de fcntl) à 24 — mot de poids
    faible en petit-boutiste, celui que le noyau lit (`unsigned int cmd`) : un 6 + 2³² est donc vu
    comme 6. Une architecture inconnue passe : le filtre ne remplace pas le profil de Docker,
    il s'y ajoute. Tous les sauts sont en avant, comme BPF l'exige."""
    prog, labels, jumps = [], {}, []

    def emit(code, k, target=None):
        if target is not None:
            jumps.append((len(prog), target))
        prog.append([code, 0, 0, k])

    emit(_BPF_LD_W_ABS, 4)
    for arch, _, _, _ in STUDENT_FILTER_ARCHES:
        emit(_BPF_JEQ_K, arch, "arch%x" % arch)
    emit(_BPF_RET_K, SECCOMP_RET_ALLOW)
    for arch, numbers, abi32, aio_numbers in STUDENT_FILTER_ARCHES:
        labels["arch%x" % arch] = len(prog)
        emit(_BPF_LD_W_ABS, 0)
        for number in aio_numbers:
            emit(_BPF_JEQ_K, number, "nosys")
        for number in numbers:
            emit(_BPF_JEQ_K, number, "cmd32" if abi32 else "cmd")
        emit(_BPF_RET_K, SECCOMP_RET_ALLOW)
    labels["cmd32"] = len(prog)
    emit(_BPF_LD_W_ABS, 24)
    for command in LOCK_COMMANDS_32:
        emit(_BPF_JEQ_K, command, "deny")
    labels["cmd"] = len(prog)
    emit(_BPF_LD_W_ABS, 24)
    for command in LOCK_COMMANDS:
        emit(_BPF_JEQ_K, command, "deny")
    emit(_BPF_RET_K, SECCOMP_RET_ALLOW)
    labels["deny"] = len(prog)
    emit(_BPF_RET_K, SECCOMP_RET_ERRNO | LOCK_DENY_ERRNO)
    labels["nosys"] = len(prog)
    emit(_BPF_RET_K, SECCOMP_RET_ERRNO | AIO_DENY_ERRNO)
    for at, target in jumps:
        prog[at][1] = labels[target] - at - 1
    return [tuple(instruction) for instruction in prog]


def _prepare_student_filter():
    """Objets ctypes du filtre, construits UNE fois dans le superviseur : le preexec_fn (après
    fork) n'a plus que deux appels à faire. None hors Linux (tests unitaires sous Windows)."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes

        class SockFilter(ctypes.Structure):
            _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                        ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

        class SockFprog(ctypes.Structure):
            _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]

        program = student_filter_program()
        instructions = (SockFilter * len(program))(*(SockFilter(*i) for i in program))
        fprog = SockFprog(len(program), instructions)
        prctl = ctypes.CDLL("libc.so.6", use_errno=True).prctl
        prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
                          ctypes.c_ulong]
        prctl.restype = ctypes.c_int
        # Les instructions sont gardées avec la structure : fprog ne fait que les pointer.
        return prctl, ctypes.addressof(fprog), (fprog, instructions)
    except (ImportError, OSError, AttributeError):
        return None


_STUDENT_FILTER = _prepare_student_filter()
PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, SECCOMP_MODE_FILTER = 38, 22, 2
STUDENT_FILTER_UNAVAILABLE = "filtre seccomp étudiant indisponible sur cet hôte"


def install_student_filter():
    """preexec_fn (fin) des processus de l'UID étudiant : pose le filtre (verrous, AIO noyau).

    FAIL-CLOSED : un filtre qui ne se pose pas ne laisse pas tourner le processus sans lui — il
    meurt (127) avant exec, avec un message sur sa sortie d'erreur. Pas d'exception : levée dans
    un preexec_fn, elle deviendrait une SubprocessError, que run_proc ne rattrape pas — un 502,
    donc un essai de plus, au lieu d'un cas en échec."""
    ok = _STUDENT_FILTER is not None
    if ok:
        prctl, fprog_address, _ = _STUDENT_FILTER
        ok = (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0
              and prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, fprog_address, 0, 0) == 0)
    if not ok:
        try:
            os.write(2, b"superviseur: filtre seccomp etudiant non pose\n")
        finally:
            os._exit(127)


def student_filter_available():
    """Le filtre étudiant se pose-t-il sur cet hôte ? Sondé dans un fils jetable, AVANT la ligne
    témoin. Faute de filtre, chaque processus étudiant meurt en 127 (install_student_filter,
    fail-closed) : le code soumis ne tourne jamais et l'étudiant recevrait 0 sur des cas qu'il n'a
    pas pu jouer. Constaté ici, c'est une panne de PLATEFORME (libc introuvable, seccomp refusé
    par l'hôte), rendue comme telle — cause « indisponible », jamais comptée contre l'étudiant."""
    if _STUDENT_FILTER is None:
        return False
    pid = os.fork()
    if pid == 0:
        try:
            prctl, fprog_address, _ = _STUDENT_FILTER
            ok = (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0
                  and prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, fprog_address, 0, 0) == 0)
        except BaseException:
            ok = False
        os._exit(0 if ok else 1)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status) == 0


def demote_student():
    """preexec_fn du processus étudiant : UID dédié, groupe de processus, limites dures."""
    mark_oom_victim()
    os.setsid()
    os.setgroups([])
    os.setgid(STUDENT_GID)
    os.setuid(STUDENT_UID)
    resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_LIMIT, FSIZE_LIMIT))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))
    install_student_filter()


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
      3. un canari qui a TOURNÉ mais fini sur une cause NON CONCLUANTE (expiré, noteur tué par
         signal) n'accuse que si AUCUN autre canari n'est confirmé de façon CONCLUANTE (il a
         tourné jusqu'au bout et rendu son attendu). Le canari n'appelle aucune fonction
         soumise et son noteur tourne sous un autre UID : sur un hôte chargé, il expire
         (limite d'une seconde possible) ou meurt de l'OOM du cgroup pendant qu'un cas réel
         passe, et la soumission honnête était accusée. Le code soumis ne distinguant pas le
         canari « pass » du canari « fail », un gel VOLONTAIRE les gèle tous les deux — et un
         canari « fail » gelé ne confirme rien : la détection du gel sélectif (les deux
         canaris gelés, un cas réel vert) est conservée ;
      4. sinon tout est confirmé → « ok », ou « indetermines » si un canari n'a rien vérifié
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

    confirmed, accusable, doubtful = [], [], []
    for c in judgeable:
        issue = outcomes[c["index"]]
        if issue.ran and issue.passed == (c["canary"] == "pass"):
            confirmed.append(c)                       # CONFIRMÉ
        elif not inconclusive(issue):
            accusable.append(c)                      # non confirmé, et imputable a priori
        elif issue.ran:
            doubtful.append(c)                       # a tourné, mais expiré ou tué — règle 3
        # sinon : compilation échouée pour une cause non concluante — règle 2, jamais d'accusation
    # Confirmé DE FAÇON CONCLUANTE : un canari « fail » lui-même expiré ou tué a bien « échoué »,
    # mais il ne prouve rien — c'est exactement ce que produit un gel des deux canaris.
    solid = [c for c in confirmed if not inconclusive(outcomes[c["index"]])]
    if not solid:
        # Aucune confirmation concluante : le gel peut être voulu, la règle 1 s'applique.
        accusable += doubtful

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
            mark_oom_victim()   # fils du PID 1 (-1000) : cf. mark_oom_victim
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
            # errors="replace" : le nom du programme (octets libres, choisis par le code
            # soumis) figure dans ces fichiers. Non UTF-8, il levait UnicodeDecodeError — une
            # ValueError, absorbée plus bas : le processus n'était ni compté ni récolté.
            with open("/proc/" + pid + "/status", "r", errors="replace") as f:
                if real_uid(f.read()) != str(STUDENT_UID):
                    continue
            states = []
            for tid in os.listdir("/proc/" + pid + "/task"):
                with open("/proc/" + pid + "/task/" + tid + "/stat", "r",
                          errors="replace") as f:
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
        remove_tree(fpath)
        os.makedirs(fpath, exist_ok=True)
        os.chown(fpath, STUDENT_UID, STUDENT_GID)
        os.chmod(fpath, 0o700)


RM = "/bin/rm"


def _remove_tree_iterative(path):
    """Repli sans `rm` (tests hors image) : parcours par pile, sans récursion Python ni suivi de
    lien. Ne lève jamais."""
    stack, seen = [path], []
    while stack:
        current = stack.pop()
        seen.append(current)
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        else:
                            os.unlink(entry.path)
                    except OSError:
                        continue
        except OSError:
            continue
    for directory in reversed(seen):
        try:
            os.rmdir(directory)
        except OSError:
            continue


def remove_tree(path):
    """Supprime `path` (dossier ou fichier) sans suivre de lien, et SANS JAMAIS LEVER.

    shutil.rmtree est récursif sous le Python des images (3.11, 3.12.3) : une arborescence de
    plus d'un millier de niveaux, que le code soumis crée en quelques millisecondes dans /tmp ou
    dans son dossier de travail, lui faisait lever RecursionError — qui n'est pas une OSError,
    donc ni `ignore_errors` ni les `except OSError` ne l'arrêtaient. Le superviseur mourait sans
    JSON : un 502 « sans verdict » à la demande de l'étudiant, celui que exception_cause existe
    pour refuser. `rm -rf` (coreutils, parcours fts) ne dépend pas de la profondeur."""
    try:
        if os.path.islink(path) or (os.path.lexists(path) and not os.path.isdir(path)):
            os.unlink(path)
            return
        if not os.path.lexists(path):
            return
    except OSError:
        return
    if os.path.exists(RM):
        try:
            # oom_victim_first : comme tout lancement, il ne garde pas le -1000 du superviseur.
            subprocess.run([RM, "-rf", "--one-file-system", "--", path],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=120, check=False,
                           preexec_fn=oom_victim_first(None))
        except (OSError, subprocess.SubprocessError):
            pass
    if os.path.lexists(path):
        _remove_tree_iterative(path)


def purge_shared_dirs():
    """Vide /tmp et /dev/shm entre deux cas : ces tmpfs survivent d'un cas a l'autre, et un
    fichier depose au cas N (un nonce exfiltre, un relais) etait lisible au cas N+1."""
    for directory in ("/tmp", "/dev/shm"):
        try:
            for ident in os.listdir(directory):
                fpath = os.path.join(directory, ident)
                remove_tree(fpath)
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
    mark_oom_victim()
    os.setsid()
    os.setgroups([])
    os.setgid(STUDENT_GID)
    os.setuid(STUDENT_UID)
    install_student_filter()


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


# Compilations du CODE SOUMIS déjà faites dans ce job, par empreinte de leurs entrées (voir
# compile_student). Le programme étudiant ne dépend que du code soumis : il est identique d'un
# cas à l'autre, canaris compris (le marqueur réservé est refusé en amont) — sauf en C#, où le
# serveur porte la classe que le harnais nomme : un harnais qui en nomme une autre recompile.
STUDENT_BUILDS = {}
# Artefacts des compilations RÉUSSIES (binaire, ou dossier de classes en Java), copiés par root
# hors du chantier de l'étudiant. Dans /box : comptés dans la mémoire du conteneur, d'où le
# plafond (st_size : un binaire creux de 1 Gio compte pour 1 Gio et n'est pas gardé).
STUDENT_BUILD_CACHE = os.path.join(BOX, "etu_compilations")
STUDENT_ARTIFACT_CAP = 64 * 1024 * 1024
# ... et en nombre de fichiers : le cache garde ses inodes tout le job, sur un /box borné à
# DockerSandbox.BOX_INODES côté execution-service (une classe Java par fichier ; une solution
# honnête en a quelques-unes).
STUDENT_ARTIFACT_MAX_FILES = 256
# Un échec NON CONCLUANT (délai dépassé, compilateur tué par signal) peut venir de l'hôte — une
# machine chargée, le cache de Go encore froid à la première compilation — et non des entrées :
# il n'est rejoué qu'une fois constaté DEUX fois. Un échec du compilateur l'est dès la première.
INCONCLUSIVE_REPLAY_AFTER = 2


class StudentBuild:
    """Résultat d'une compilation étudiante, tel qu'il sera rejoué."""

    def __init__(self, code, expired, out_text, err_text, artifact=None):
        self.code, self.expired = code, expired
        self.out_text, self.err_text = out_text, err_text
        self.artifact = artifact          # (chemin dans STUDENT_BUILD_CACHE, dossier ?)
        self.occurrences = 1

    def succeeded(self):
        return self.code == 0 and not self.expired

    def inconclusive(self):
        return self.expired or (self.code is not None and self.code < 0)

    def replayable(self):
        if self.succeeded():
            return self.artifact is not None
        return not self.inconclusive() or self.occurrences >= INCONCLUSIVE_REPLAY_AFTER


def student_build_key(cmd, cwd, env, inputs, case_dir):
    """Empreinte d'une compilation ÉTUDIANTE : commande, dossier, environnement et octets des
    sources, le chemin du cas neutralisé (seule différence d'un cas à l'autre). Testée.

    Les sources sont relues sans suivre de lien : elles vivent dans le chantier de l'étudiant
    (root vient de les y écrire, aucun processus étudiant n'a encore tourné dans ce cas)."""
    case_dir = case_dir.rstrip(os.sep)
    prefix = case_dir + os.sep
    digest = hashlib.sha256()

    def feed(text):
        # Le dossier du cas LUI-MÊME aussi (dossier de travail de javac), pas seulement ce
        # qu'il contient.
        text = prefix if text == case_dir else text
        digest.update(text.replace(prefix, "\0cas" + os.sep).encode("utf-8", "surrogatepass"))
        digest.update(b"\0")

    for part in list(cmd) + [cwd] + sorted("%s=%s" % item for item in env.items()):
        feed(part)
    for path in inputs:
        feed(path)
        fd = os.open(path, os.O_RDONLY | O_NO_LINK)
        with os.fdopen(fd, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 16), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def replay_output(path, text):
    """Réécrit une sortie mémorisée (root, 0600, sans suivre de lien)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | O_NO_LINK, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", errors="replace") as f:
        f.write(text)


def walk_tree(top):
    """os.walk sans RÉCURSION Python ni suivi de lien : (dossier, sous-dossiers, autres entrées).

    os.walk est récursif avant Python 3.12, et la plupart des images ont 3.11 : un arbre de plus
    d'un millier de niveaux — un `package a.a.a…` que javac déploie en dossiers, un mkdir/chdir
    en boucle du code soumis — lui faisait lever RecursionError, qui n'est pas une OSError et
    tuait le cas en « erreur interne » (502, réessai offert). Un lien, même vers un dossier, est
    rangé avec les autres entrées et jamais parcouru ; un dossier illisible est sauté."""
    stack = [top]
    while stack:
        root = stack.pop()
        try:
            with os.scandir(root) as entries:
                listed = list(entries)
        except OSError:
            continue
        dirs, others = [], []
        for entry in listed:
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            (dirs if is_dir else others).append(entry.name)
        yield root, dirs, others
        stack.extend(os.path.join(root, name) for name in reversed(dirs))


def artifact_files(path):
    """Fichiers d'un artefact (fichier ou dossier) : liste de chemins relatifs ("" pour un
    fichier seul), ou None s'il ne se garde pas — lien, fichier spécial, plus de
    STUDENT_ARTIFACT_CAP octets (taille apparente : la copie remplit les trous d'un fichier
    creux) ou de STUDENT_ARTIFACT_MAX_FILES fichiers. Lu sans suivre de lien (chantier de
    l'étudiant). Testée."""
    st = os.lstat(path)
    if stat.S_ISREG(st.st_mode):
        return [""] if st.st_size <= STUDENT_ARTIFACT_CAP else None
    if not stat.S_ISDIR(st.st_mode):
        return None
    files, total = [], 0
    for root, dirs, names in walk_tree(path):
        for name in dirs + names:
            full = os.path.join(root, name)
            st = os.lstat(full)
            if stat.S_ISDIR(st.st_mode):
                continue
            if not stat.S_ISREG(st.st_mode):
                return None
            total += st.st_size
            if total > STUDENT_ARTIFACT_CAP or len(files) >= STUDENT_ARTIFACT_MAX_FILES:
                return None
            files.append(os.path.relpath(full, path))
    return files


def copy_regular(src, dst, owner=None):
    """Copie un fichier ORDINAIRE sans suivre de lien, ni à la lecture ni à l'écriture (la
    destination ne doit pas exister). owner=(uid, gid) : la copie lui est donnée, en 0700."""
    fd_in = os.open(src, os.O_RDONLY | O_NO_LINK)
    try:
        if not stat.S_ISREG(os.fstat(fd_in).st_mode):
            raise OSError("artefact non ordinaire : %s" % src)
        fd_out = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NO_LINK, 0o700)
        try:
            for chunk in iter(lambda: os.read(fd_in, 1 << 20), b""):
                os.write(fd_out, chunk)
            if owner is not None:
                os.fchown(fd_out, *owner)
                os.fchmod(fd_out, 0o700)
        finally:
            os.close(fd_out)
    finally:
        os.close(fd_in)


def save_artifact(path, key):
    """Garde l'artefact d'une compilation RÉUSSIE → (copie, dossier ?), ou None.

    Appelée juste après la compilation : run_proc a tué le groupe et balayé l'UID étudiant, aucun
    processus de l'étudiant ne peut plus toucher son chantier pendant la copie."""
    dest = os.path.join(STUDENT_BUILD_CACHE, key)
    try:
        files = artifact_files(path)
        if files is None:
            return None
        os.makedirs(STUDENT_BUILD_CACHE, mode=0o700, exist_ok=True)
        if files == [""]:
            copy_regular(path, dest)
            return dest, False
        os.mkdir(dest, 0o700)
        for rel in files:
            os.makedirs(os.path.dirname(os.path.join(dest, rel)), mode=0o700, exist_ok=True)
            copy_regular(os.path.join(path, rel), os.path.join(dest, rel))
        return dest, True
    except OSError:
        # Rien de gardé : les cas suivants recompilent, comme avant.
        if os.path.isdir(dest) and not os.path.islink(dest):
            remove_tree(dest)
        else:
            try:
                os.unlink(dest)
            except OSError:
                pass
        return None


def restore_artifact(artifact, path):
    """Rend l'artefact gardé à `path`, donné à l'étudiant comme s'il venait de le compiler.
    → vrai si c'est fait ; faux = recompiler (une copie partielle d'un fichier seul est retirée,
    celle d'un dossier de classes est écrasée par la compilation)."""
    saved, is_dir = artifact
    owner = (STUDENT_UID, STUDENT_GID)
    try:
        if not is_dir:
            copy_regular(saved, path, owner)
            return True
        for root, _, names in walk_tree(saved):
            target_dir = os.path.normpath(os.path.join(path, os.path.relpath(root, saved)))
            if not os.path.isdir(target_dir):
                os.mkdir(target_dir, 0o700)
                os.chown(target_dir, *owner)
            for name in names:
                copy_regular(os.path.join(root, name), os.path.join(target_dir, name), owner)
        return True
    except OSError:
        if not is_dir:
            try:
                os.unlink(path)
            except OSError:
                pass
        return False


def compile_student(cmd, cwd, env, case_dir, inputs, out_path, err_path, artifact):
    """Compile le CODE SOUMIS sous son UID → (exit, timed_out), comme run_proc. `artifact` :
    ce que la compilation produit (binaire, ou dossier de classes en Java).

    Une compilation n'est faite qu'UNE fois par job pour des entrées identiques, puis rejouée
    aux cas suivants. Sans cela, une compilation lente — boucle d'évaluation constante en Rust
    jusqu'au délai de 90 s, bombe de templates C++ jusqu'à l'OOM, ou compilation qui RÉUSSIT
    juste avant le délai — était refaite à CHAQUE cas, canaris compris : 451 s de place tenue
    pour trois cas, sans rien changer au verdict.
    - Réussite : l'artefact, gardé par root hors du chantier, est recopié dans celui du cas ;
      s'il n'a pas pu être gardé (trop gros) ou rendu, le cas recompile.
    - Échec : même code de sortie, même expiration ou mort par signal (donc même verdict et même
      traitement des canaris), mêmes messages du compilateur. Un échec NON CONCLUANT n'est
      rejoué qu'à sa deuxième occurrence (INCONCLUSIVE_REPLAY_AFTER).
    Rien n'est mémorisé quand une sortie a été perdue (tmpfs saturé : la cause est l'espace)."""
    key = student_build_key(cmd, cwd, env, inputs, case_dir)
    known = STUDENT_BUILDS.get(key)
    if known is not None and known.replayable():
        if not known.succeeded() or restore_artifact(known.artifact, artifact):
            replay_output(out_path, known.out_text)
            replay_output(err_path, known.err_text)
            if known.expired:
                EXIT_STATE.expired = True
            if known.code is not None and known.code < 0:
                EXIT_STATE.killed_by_signal = True
            event("compilation_rejouee" if known.succeeded() else "echec_compilation_rejoue",
                  case=EXIT_STATE.case)
            return known.code, known.expired
    code, expired = run_proc(cmd, cwd, env, COMPILE_TIMEOUT_S, out_path, err_path,
                             preexec_student_compile)
    if EXIT_STATE.lost:
        return code, expired
    build = StudentBuild(code, expired, read_capped(out_path), read_capped(err_path))
    if build.succeeded():
        build.artifact = (known.artifact if known is not None and known.succeeded()
                          else save_artifact(artifact, key))
        if build.artifact is None:
            return code, expired
    elif known is not None and known.succeeded():
        # Entrées identiques, réussite déjà constatée : cet échec vient de l'environnement (la
        # restauration a échoué, faute de place) — la réussite reste celle que l'on rejoue.
        return code, expired
    elif known is not None and known.inconclusive() and build.inconclusive():
        build.occurrences = known.occurrences + 1
    STUDENT_BUILDS[key] = build
    return code, expired


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
    for r, ds, fs in walk_tree(tree_root):
        for ident in ds + fs:
            fpath = os.path.join(r, ident)
            if not os.path.islink(fpath):
                set_owner_mode(fpath, uid, gid, file_mode, dir_mode)
    set_owner_mode(tree_root, uid, gid, dir_mode, dir_mode)


def chown_tree(tree_root, uid, gid):
    """chown recursif, racine comprise — sans suivre aucun lien (cf. lock_sources)."""
    if os.path.islink(tree_root):
        return
    for r, ds, fs in walk_tree(tree_root):
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
    defaut, il naissait en 0755 et restait lisible de tous jusqu'au chmod 0500.

    Victime de l'OOM après le code soumis (mark_oom_victim, OOM_ADJ_TRUSTED) : un compilateur
    qui hériterait du -1000 du superviseur serait intuable."""
    mark_oom_victim(OOM_ADJ_TRUSTED)
    os.setsid()
    os.umask(0o077)


def open_output(path):
    """Ouvre un fichier de sortie SANS suivre un lien symbolique. Défense en profondeur : les
    sorties vivent dans des dossiers root (/box/.sorties en 0700 en mode exec, le dossier du
    cas en mode evaluate), mais un chemin que l'UID étudiant pourrait un jour atteindre ne doit
    pas pouvoir faire écrire root ailleurs par un lien.
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
                    # troncature scinderait la ligne en cours — et si c'est celle du nonce,
                    # le verdict ne la reconnaît plus : une réponse juste serait notée fausse.
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
            # MÊME libellé que read_capped, au mot près : un seul texte signale une sortie
            # tronquée, où qu'elle ait été coupée.
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


def run_proc(cmd, cwd, env, timeout_s, out_path, err_path, preexec, stdin_path=None):
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
    stdin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
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
                                stderr=subprocess.PIPE, stdin=stdin,
                                preexec_fn=oom_victim_first(preexec))
        if stdin is not subprocess.DEVNULL:
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
    for root, dirs, files in walk_tree(src_dir):
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
    exception est un bogue de LOGIQUE du superviseur : seule celle-la rend la notation incomplete
    (502, tentative a reprendre). Ce bogue se declenche en traitant le code soumis (extraction des
    signatures, bouchons), qui peut donc le provoquer : execution-service le compte « sans
    verdict » (#116, S4), et un bogue deterministe sur une soumission honnete finit « a revoir »."""
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


def grader_output_lost(code, passed):
    """Le NOTEUR est-il sorti en 0 SANS que son jeton nous parvienne ? PURE (testee).

    Les six noteurs ne rendent 0 qu'apres avoir ecrit le jeton sur leur stderr : un code 0 sans
    jeton veut dire que l'ecriture a echoue CHEZ LUI — son stderr est un fichier de /box, et le
    tmpfs etait plein. Aucune erreur ne remonte au superviseur dans ce cas (la fermeture du
    fichier reussit), et le cas sortait en « Le harnais a renvoye faux », sans evenement
    `espace_sature` : l'etudiant et le prof cherchaient un bogue de logique inexistant. Le cas
    reste en echec (fail-closed) ; seul le diagnostic change."""
    return code == 0 and not passed


def note_grader_output_lost(code, passed):
    """Pose l'etat « sortie perdue » du cas si le noteur est sorti en 0 sans jeton."""
    if grader_output_lost(code, passed):
        EXIT_STATE.lost = True
        event("espace_sature", case=EXIT_STATE.case,
              detail="noteur sorti en 0 sans jeton : sortie perdue")


def grading_incomplete(real_cases):
    """La notation des cas REELS est-elle incomplete pour une cause NON IMPUTABLE ? PURE (testee).

    Vrai SEULEMENT si un cas a subi une erreur interne du superviseur : notre code a leve en
    traitant le code soumis. Execution-service en fait un 502 sur le chemin INTERNE, de cause
    « sans verdict » : la tentative est supprimee et l'etudiant resoumet, jusqu'au plafond de
    core, au-dela duquel elle est gardee « a revoir » (#116, S4).

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
    Le verdict des canaris s'en sert pour ne pas accuser : un processus tué ou expiré ne dit
    rien de la chaîne de notation, et canary_verdict en concluait à tort qu'elle ne tranchait
    plus."""
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


JAVAP_EXTENDS = re.compile(r"^[\w ]*?\bclass\s+([\w.$]+)\s+extends\s+([\w.$]+)", re.M)


JAVAP_INTERFACE = re.compile(r"^[\w ]*?\binterface\s+([\w.$]+)", re.M)
JAVAP_DEFAULT = re.compile(
    r"^[ \t]+(?:public\s+)?default\s+([\w.$\[\]]+)\s+(\w+)\(([^()]*)\)(?:\s+throws\s+[^;]+)?;", re.M)


def java_interfaces(javap_output):
    """Interfaces qu'une classe implémente — ou qu'une INTERFACE étend (`interface Polygone
    extends Forme`) — en forme source, génériques retirés. PURE (testée)."""
    text = javap_output or ""
    found = re.search(r"\bimplements\s+([^{]+)\{", text)
    if not found and JAVAP_INTERFACE.search(text) and not JAVAP_CLASS.search(text):
        found = re.search(r"\binterface\s+[\w.$]+(?:<[^{]*?>)?\s+extends\s+([^{]+)\{", text)
    if not found:
        return []
    names = re.sub(r"<[^<>]*>", "", re.sub(r"<[^<>]*>", "", found.group(1)))
    return [n.strip().replace("$", ".") for n in names.split(",") if n.strip()]


def java_interface_defaults(javap_output):
    """(interface, [méthodes `default` transportables]) d'un bloc javap d'interface, ou
    (None, []). FONCTION PURE (testée). Une méthode `default` non redéfinie s'appelle sur tout
    objet qui implémente l'interface : sans elle, le bouchon ne la portait pas, et l'étudiant
    qui s'en sert recevait 0 quand la solution du prof, qui la redéfinissait, passait."""
    header = JAVAP_INTERFACE.search(javap_output or "")
    if not header or JAVAP_CLASS.search(javap_output or ""):
        return None, []
    methods = []
    for ret, ident, args in JAVAP_DEFAULT.findall(javap_output):
        types = [a.strip() for a in args.split(",") if a.strip()]
        if ret in JSON_TYPES and all(t in JSON_TYPES for t in types):
            methods.append((ret, ident, types))
    return header.group(1).replace("$", "."), methods


def java_superclass(javap_output):
    """Classe mère déclarée dans un bloc javap (forme source `Outer.Inner`), ou None. PURE."""
    found = JAVAP_EXTENDS.search(javap_output or "")
    return found.group(2).replace("$", ".") if found else None


def inherit_instance_methods(apis, parents, hiding=None):
    """Ajoute à chaque classe les méthodes d'instance HÉRITÉES d'une classe du code soumis.
    FONCTION PURE (testée).

    `apis` : nom → (constructeurs, méthodes d'instance) ; `parents` : nom → classe mère, liste
    de parents (classe mère puis interfaces, en Java), ou None. Les ancêtres sont parcourus en
    largeur, la classe mère d'abord. Rend un nouveau dict nom → méthodes d'instance, celles de la classe d'abord, puis
    celles de ses ancêtres qu'elle ne redéfinit pas (même nom, mêmes types). Sans cela, le
    bouchon ne portait que les méthodes DÉCLARÉES : `new Carre(3).aire()` avec un `aire()`
    hérité de `Forme` ne compilait pas, et l'étudiant qui hérite — l'esprit d'un exercice
    d'héritage — recevait 0, quand la solution du prof, qui redéfinissait, passait. Une chaîne
    circulaire (impossible en Java compilé) s'arrête au premier nom déjà vu.

    `hiding` (C++) : classe → noms de méthodes qu'elle DÉCLARE, toutes sections et tous types
    confondus. En C++, déclarer `aire(int)` dans `Carre` masque TOUTES les surcharges `aire` de
    `Forme` : hériter `aire()` quand même faisait générer au serveur un appel qui ne compile pas
    (« Échec de compilation » sur une réponse juste). Java et C# résolvent les surcharges en
    remontant la hiérarchie : pas de masquage par nom (None)."""
    def parents_of(name):
        found = parents.get(name)
        if found is None:
            return []
        return [found] if isinstance(found, str) else list(found)

    merged = {}
    for name, (_ctors, own) in apis.items():
        methods = list(own)
        seen = {(m[1], tuple(m[2])) for m in methods}
        hidden = set(hiding.get(name, ())) if hiding is not None else set()
        visited = {name}
        queue = parents_of(name)
        while queue:
            ancestor = queue.pop(0)
            if ancestor not in apis or ancestor in visited:
                continue
            visited.add(ancestor)
            for method in apis[ancestor][1]:
                key = (method[1], tuple(method[2]))
                if key not in seen and method[1] not in hidden:
                    seen.add(key)
                    methods.append(method)
            if hiding is not None:
                hidden |= set(hiding.get(ancestor, ()))
            queue.extend(parents_of(ancestor))
        merged[name] = methods
    return merged


def java_object_stub(source_name, ctors, method_list, statics=()):
    """Bouchon d'une classe OBJET : constructeur → poignée, méthodes → appel sur la poignée.

    FONCTION PURE (testée). Une classe imbriquée (`Outer.Inner`) est rendue dans sa coquille, pour
    que le harnais puisse l'écrire exactement comme l'étudiant l'a déclarée. `statics` : les
    méthodes statiques de CETTE classe, que le harnais appelle par son nom (`Aide.carre(3)`) —
    aplaties dans la seule classe principale, elles y étaient introuvables (« cannot find
    symbol » sur une réponse juste)."""
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
    for ret, ident, types in statics:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        # La CLASSE voyage avec le nom (`Aide#calcul(int)`) : sans elle, le serveur cherchait
        # d'abord dans la classe principale, et une statique homonyme `Solution.calcul` y était
        # exécutée à la place d'`Aide.calcul` — faux verdict, sans diagnostic.
        body += ["        public static %s %s(%s) {" % (ret, ident, params),
                  "            return MooditRpc.%s(\"%s#%s\", new Object[]{%s});"
                  % (JAVA_RPC_FN[JSON_TYPES[ret]], source_name, rpc_name(ident, types), args),
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


def trailing_defaults(params):
    """Nombre de paramètres FINAUX à valeur par défaut (`int acc = 0`). FONCTION PURE (testée)."""
    count = 0
    for param_group in reversed([p for p in (params or "").split(",") if p.strip()]):
        if "=" not in param_group:
            break
        count += 1
    return count


def with_default_arities(entries):
    """[(retour, nom, types, nb de défauts)] → [(retour, nom, types)], avec pour chaque entrée
    ses arités RÉDUITES (`somme(int, int = 0)` donne aussi `somme(int)`). FONCTION PURE (testée).

    Le bouchon n'avait que l'arité complète : `somme(4)`, `Rect a;` sur `Rect(int l = 1, …)`, ne
    compilaient pas dans le noteur — 0 sur une réponse juste, message qui accusait le harnais.
    Le serveur appelle avec moins d'arguments, et la valeur par défaut s'applique chez
    l'étudiant (aucun texte soumis n'entre dans le noteur). Une arité réduite qui heurterait une
    déclaration explicite, ou celle d'une autre entrée, n'est pas ajoutée : l'appel serait
    ambigu pour le compilateur du serveur."""
    explicit = {(name, tuple(types)) for _r, name, types, _d in entries}
    produced = collections.Counter(
        (name, tuple(types[:len(types) - k]))
        for _r, name, types, d in entries for k in range(1, d + 1))
    result = []
    for ret, name, types, defaults in entries:
        result.append((ret, name, types))
        for k in range(1, defaults + 1):
            key = (name, tuple(types[:len(types) - k]))
            if key not in explicit and produced[key] == 1:
                result.append((ret, name, list(key[1])))
    return result


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


def java_stub_source(class_name, methods, objects=(), self_ctors=(), self_instance=(),
                     class_statics=None):
    """Classe-BOUCHON compilée avec le harnais : mêmes signatures, corps = appel RPC.

    FONCTION PURE (testée). Le harnais du prof compile contre elle sans rien savoir ; aucune
    ligne de code étudiant n'entre dans ce programme. `objects` apporte les classes IMBRIQUÉES
    proxifiées par poignée, pour que `new Solution.Rectangle(3, 4).aire()` s'écrive naturellement
    alors que l'objet vit, lui, dans le processus de l'étudiant. `class_statics` ({classe:
    [statiques]}) donne à chaque classe secondaire ses propres méthodes statiques."""
    class_statics = class_statics or {}
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
        statics = class_statics.get(source_name, ())
        if "." in source_name:
            # Classe IMBRIQUEE (Solution.Rectangle) : dans sa coquille, comme l'etudiant l'a ecrite.
            src_lines.append(java_object_stub(source_name, ctors, instance, statics))
        else:
            top_level.append(java_object_stub(source_name, ctors, instance, statics))
    # Une statique d'une AUTRE classe, aplatie ici, peut porter la signature d'une methode
    # d'instance de la classe principale : deux membres identiques (« already defined ») sur
    # une reponse juste. Elle reste appelable par sa propre classe (class_statics).
    own = {(ident, tuple(types)) for _, ident, types in (self_instance if self_ctors else ())}
    for ret, ident, types in methods:
        if (ident, tuple(types)) in own:
            continue
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


def java_grader_objects(obj_list, harness_code):
    """Classes soumises qui reçoivent un bouchon dans le noteur. PURE (testée).

    Une classe au nom d'un type de java.lang que le harnais n'emploie PAS n'en reçoit pas : son
    bouchon, compilé dans le paquet du noteur, y masquait le vrai type pour le runtime généré
    (`Long.toHexString`, `String`, `Object`…) — « Le harnais ne compile pas » et 0 sur une
    réponse juste qui déclare une `class Long` d'aide. Même critère que java_shadowed_names :
    le nom est soit refusé (le harnais l'emploie), soit sans bouchon (il ne l'emploie pas).
    Pour une classe imbriquée (Solution.Long), c'est le dernier segment qui compte."""
    bare = blank_code(harness_code or "")
    kept = []
    for entry in obj_list:
        simple = entry[0].rsplit(".", 1)[-1]
        if simple in JAVA_LANG_TYPES and not re.search(r"\b%s\b" % re.escape(simple), bare):
            continue
        kept.append(entry)
    return kept


def java_grader_source(harness_code, nonce):
    """Programme NOTEUR : runtime RPC + harnais booléen du prof + nonce.

    FONCTION PURE (testée). stdin/stdout sont le tube vers le processus étudiant ; le nonce part
    sur stderr, que l'étudiant ne tient pas. Une exception du harnais vaut faux (fail-closed)."""
    # AUCUN import : les bouchons des classes soumises sont compilés avec le noteur, dans le même
    # paquet, et un import à nom simple l'emporte sur eux. Une classe soumise `PrintStream` ou
    # `BufferedReader` devenait, dans le harnais, celle de java.io — « le harnais ne compile
    # pas » sur une réponse juste. Les quatre classes sont donc nommées en entier.
    return """
final class MooditRpc {
    private static final java.io.BufferedReader ENTREE = new java.io.BufferedReader(
            new java.io.InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8));
    private static final java.io.PrintStream SORTIE = System.out;

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


# Serveur RPC du code soumis (cf. java_server_source, qui qualifie les types de java.lang).
JAVA_SERVER_TEMPLATE = """import java.lang.reflect.Method;
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
                // La CAUSE, pas l'enveloppe de la reflexion : `InvocationTargetException` seule
                // ne disait rien au prof, alors que `ArithmeticException: / by zero` designe
                // la faute du code soumis.
                Throwable cause = t;
                if (t instanceof java.lang.reflect.InvocationTargetException && t.getCause() != null) {
                    cause = t.getCause();
                }
                reponse = "{\\"ok\\":false,\\"id\\":\\"" + entre(ligne, "\\"id\\":\\"", "\\"")
                        + "\\",\\"error\\":\\"" + String.valueOf(cause).replace('"', '\\'') + "\\"}";
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
        // `Aide#calcul(int)` : statique d'une classe NOMMEE par le bouchon, cherchee la seulement.
        String[] classes = new String[] {__CLASSES__};
        int diese = appel.indexOf('#');
        if (diese >= 0) {
            classes = new String[] {appel.substring(0, diese).replace('.', '$')};
            appel = appel.substring(diese + 1);
        }
        String nom = base(appel);
        String brut = entre(ligne, "\\"args\\":[", "]");
        Object[] args = decoupe(brut);
        Method cible = null;
        // TOUTES les classes du code soumis, principale d'abord : le bouchon aplatit les
        // statiques de toutes les classes dans la classe principale, la recherche doit couvrir
        // le meme perimetre — sinon une statique d'une classe secondaire etait declaree par le
        // bouchon puis introuvable ici, et une reponse juste etait notee 0.
        for (String __c : classes) {
            for (Method m : Class.forName(__c).getDeclaredMethods()) {
                // STATIQUE exigee : une methode d'instance de meme signature dans une autre
                // classe etait retenue la premiere, et son invocation sans objet levait.
                if (m.getName().equals(nom) && java.lang.reflect.Modifier.isStatic(m.getModifiers())
                        && signe(m.getParameterTypes(), appel, args.length)) {
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
        // Classe de l'objet D'ABORD, puis ses classes meres : une methode heritee (`aire()` de
        // `Forme` sur un `Carre`) est declaree par le bouchon, elle doit etre trouvee ici.
        for (Class<?> k = instance.getClass(); k != null; k = k.getSuperclass()) {
            for (Method m : k.getDeclaredMethods()) {
                if (!m.getName().equals(nom) || java.lang.reflect.Modifier.isStatic(m.getModifiers())
                        || !signe(m.getParameterTypes(), appel, args.length)) {
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
        }
        // Methode `default` d'une interface, non redefinie : ni la classe ni ses meres ne la
        // declarent, getMethods() la rend (publique par construction).
        for (Method m : instance.getClass().getMethods()) {
            if (!m.isDefault() || !m.getName().equals(nom)
                    || !signe(m.getParameterTypes(), appel, args.length)) {
                continue;
            }
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
"""


def java_qualify_lang(source):
    """Qualifie (`java.lang.String`) chaque type de java.lang nommé simplement. PURE (testée).

    Le serveur généré est compilé DANS le paquet du code soumis : une classe soumise du même
    nom (`class Long`, `class String`) l'emporte sur l'import implicite de java.lang, et le
    serveur ne compilait plus — « Erreur interne du noteur » et 0 sur une réponse juste. Les
    noms déjà qualifiés (précédés d'un point) et les annotations sont laissés tels quels."""
    return JAVA_LANG_WORD.sub(r"java.lang.\1", source)


JAVA_LANG_WORD = re.compile(r"(?<![\w.$@])(%s)(?![\w$])"
                            % "|".join(sorted(JAVA_LANG_TYPES, key=len, reverse=True)))


def java_server_source(class_names):
    """Programme ÉTUDIANT : son code, plus une boucle qui répond aux appels par RÉFLEXION.

    FONCTION PURE (testée). Aucun nonce, aucun harnais, aucun attendu : ce processus ne peut
    rien apprendre du verdict, et rien de ce qu'il écrit ne peut le produire. Les noms des
    classes soumises sont insérés APRÈS la qualification : ce sont des chaînes, à garder."""
    return java_qualify_lang(JAVA_SERVER_TEMPLATE).replace(
        "__CLASSES__", ", ".join(chr(34) + n + chr(34) for n in class_names))


# ─────────────────────────── Go : bouchon et aiguillage TYPÉS ───────────────────────────
# Go n'a pas de réflexion utilisable ici : les deux côtés sont générés à partir des signatures
# lues dans la source de l'étudiant. Le code noté part dans un BINAIRE séparé (le harnais n'est
# ni compilé avec lui, ni présent dans son système de fichiers).

# Resultat unique : nu (`int`), entre parentheses (`(int)`) ou NOMME (`(r int)`) — les deux
# dernieres formes etaient ignorees, « Aucune fonction exploitable », 0 sur une reponse juste.
GO_RESULT = r"(?:\(\s*(?:\w+\s+)?([\w\[\]\*\.]+)\s*\)|([\w\[\]\*\.]+))?"
GO_FUNC = re.compile(r"^func\s+(\w+)\s*\(([^()]*)\)\s*" + GO_RESULT + r"\s*\{", re.M)


def go_funcs(source):
    """(nom, parametres, retour) des fonctions de premier niveau, retour sans ses parentheses."""
    return [(ident, params, paren or bare) for ident, params, paren, bare
            in GO_FUNC.findall(source or "")]
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


def harness_mentions(harness_code, name):
    """Le harnais emploie-t-il ce nom ? FONCTION PURE (testée).

    Recherche du MOT dans le CODE du harnais, commentaires et littéraux blanchis (blank_code,
    chaînes brutes Go comprises) : un `max` cité en commentaire n'emploie rien, et faisait
    refuser la fonction d'aide `max` d'une réponse juste (revue #246)."""
    code = blank_code(harness_code or "", backticks=True)
    return re.search(r"(?<!\w)%s(?!\w)" % re.escape(name), code) is not None


# Identifiants prédéclarés dont le SERVEUR généré (compilé dans le paquet de l'étudiant) se
# sert : une déclaration soumise du même nom l'empêcherait de compiler, harnais ou pas.
GO_SERVER_PREDECLARED = frozenset("""
    append bool false float64 int int64 len nil panic recover string true
""".split())


def go_hidden_names(names, harness_code):
    """Noms soumis qui masquent un identifiant prédéclaré ou un paquet du harnais.
    FONCTION PURE (testée). Rend (réservés à refuser, paquets à refuser, noms à omettre).

    Refusé : le nom que le HARNAIS emploie (il ne pourrait plus désigner l'intégré) ou dont le
    serveur généré a besoin. Omis du noteur, sans refus : le nom que le harnais n'emploie pas —
    son bouchon ne servirait à rien et masquerait l'intégré dans le code généré du noteur."""
    reserved = go_reserved_names(names)
    packages = go_harness_package_names(names)
    refused = [n for n in reserved
               if n in GO_SERVER_PREDECLARED or harness_mentions(harness_code, n)]
    refused_packages = [n for n in packages if harness_mentions(harness_code, n)]
    hidden = [n for n in reserved + packages if n not in refused + refused_packages]
    return refused, refused_packages, hidden


GO_PACKAGE_DECL = re.compile(r"^(?:func|type|var|const)\s+(\w+)", re.M)
GO_GROUP_OPEN = re.compile(r"^(?:var|const|type)\s*\(\s*\n", re.M)
GO_GROUP_CLOSE = re.compile(r"^\)", re.M)


def go_group_bodies(source):
    """Corps des déclarations groupées (`var (` … `)` en début de ligne). PURE (testée).

    En DEUX recherches enchaînées, pas en un seul motif `ouverture(.*?)^\\)` : celui-ci
    repartait de chaque ouverture jusqu'à la fin du texte quand aucune `)` ne la fermait —
    100 Ko de `var (` prenaient 12 s par cas, hors de tout délai. Ici, la première ouverture
    sans fermeture arrête tout : aucune des suivantes ne peut se fermer non plus."""
    src_text = source or ""
    bodies = []
    position = 0
    while True:
        opened = GO_GROUP_OPEN.search(src_text, position)
        if not opened:
            break
        closed = GO_GROUP_CLOSE.search(src_text, opened.end())
        if not closed:
            break
        bodies.append(src_text[opened.end():closed.start()])
        position = closed.end()
    return bodies


def go_package_names(source):
    """TOUS les noms déclarés au niveau du paquet par le code soumis. FONCTION PURE (testée).

    Fonctions de toute signature, types, variables et constantes, formes groupées comprises
    (`var ( a = 1 ; b, c int )`). Une méthode (`func (r T) f()`) n'est pas un nom de paquet."""
    names = list(GO_PACKAGE_DECL.findall(source or ""))
    for body in go_group_bodies(source):
        for line in body.splitlines():
            hit = re.match(r"\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)", line)
            if hit:
                names += [n.strip() for n in hit.group(1).split(",")]
    return list(dict.fromkeys(names))


def go_server_hidden(source):
    """Noms de paquet soumis qui masquent un identifiant dont le SERVEUR généré a besoin.

    FONCTION PURE (testée). Le serveur est compilé dans le paquet de l'étudiant : une
    `var string = …`, une `const true = …` ou une `func int(xs []int) int` (signature non
    transportable, donc absente des bouchons) l'empêchait de compiler — « Échec de compilation »
    dans un fichier que l'étudiant n'a pas écrit."""
    return [n for n in go_package_names(source) if n in GO_SERVER_PREDECLARED]


def go_without_hidden(methods, obj_list, hidden):
    """API du NOTEUR sans les noms à omettre (cf. go_hidden_names). FONCTION PURE (testée)."""
    hidden = set(hidden)
    kept_methods = [m for m in methods if m[1] not in hidden]
    kept_objects = [(typ, [c for c in ctors if c[0] not in hidden], method_list)
                    for typ, ctors, method_list in obj_list if typ not in hidden]
    return kept_methods, kept_objects


def go_signatures(source):
    """Fonctions de premier niveau du code étudiant → [(retour, nom, [types])].

    FONCTION PURE (testée). On accepte `func f(a int, b int) int` et la forme groupée
    `func f(a, b int) int`. `main` est écartée, ainsi que toute signature dont un type n'est pas
    marshalable : le harnais qui l'appellerait ne compilerait pas — message au prof, jamais un
    faux verdict."""
    hits = []
    for ident, params, ret in go_funcs(source):
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
    r"^func\s+\(\s*(?:\w+\s+)?(\*?)(\w+)\s*\)\s*(\w+)\s*\(([^()]*)\)\s*" + GO_RESULT + r"\s*\{", re.M)


def go_methods(source):
    """(etoile, recepteur, nom, parametres, retour) des methodes, retour sans parentheses."""
    return [(star, receiver, ident, params, paren or bare) for star, receiver, ident, params, paren, bare
            in GO_METHOD.findall(source or "")]


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
    for ident, params, ret in go_funcs(source):
        # `func NewRectangle(…) *Rectangle` est la forme la plus répandue : sans retirer l'étoile,
        # ce constructeur n'était pas reconnu et la question n'était pas proxifiée.
        if (ret or "").lstrip("*") not in structs or ident == "main":
            continue
        types = _go_param_types(params)
        if types is not None:
            target_file = (ret or "").lstrip("*")
            by_type[target_file][0].append((ident, types, (ret or "").startswith("*")))
    for _, receiver, ident, params, ret in go_methods(source):
        if receiver not in structs:
            continue
        if (ret or "") not in GO_TYPES:
            continue
        types = _go_param_types(params)
        if types is not None:
            by_type[receiver][1].append((ret, ident, types))
    # Méthodes PROMUES par composition (`type Carre struct { Rectangle }`) : l'héritage de Go.
    # `NewCarre(3).Aire()` compile chez l'étudiant, mais le bouchon ne portait pas `Aire` — 0
    # sur une réponse juste. Une méthode du type lui-même masque toute méthode promue du même
    # nom (règle de Go), quels que soient ses paramètres.
    parents = {t: [e for e in embedded if e in structs]
               for t, embedded in go_embedded_types(source).items()}
    hiding = {t: {m[1] for m in by_type[t][1]} for t in by_type}
    merged = inherit_instance_methods(by_type, parents, hiding)
    for t in by_type:
        by_type[t][1][:] = merged[t]
    return [(t, c, m) for t, (c, m) in sorted(by_type.items()) if m and (c or t in field_list)]


def go_embedded_types(source):
    """Types EMBARQUÉS de chaque structure (champ anonyme `T` ou `*T`, étiquette admise).
    FONCTION PURE (testée)."""
    found = {}
    for typ, body in GO_STRUCT_BODY.findall(source or ""):
        for src_line in body.splitlines():
            bare_line = src_line.split("//")[0].strip()
            field = re.fullmatch(r"\*?([A-Za-z_]\w*)(?:\s+`[^`]*`)?", bare_line)
            if field:
                found.setdefault(typ, []).append(field.group(1))
    return found


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


# Corps en `[^{}]*` et non `[^}]*` : sans accolade fermante, le motif courait de CHAQUE
# `type X struct{` jusqu'au bout de la source (temps quadratique). Le resultat est le meme : un
# corps qui contient `{` (champ `struct{...}` anonyme) etait deja ecarte par go_struct_fields.
GO_STRUCT_BODY = re.compile(r"^type\s+(\w+)\s+struct\s*\{([^{}]*)\}", re.M | re.S)


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
        # Une structure SANS CHAMP (`type Calculatrice struct{}`) est capturable aussi : son
        # littéral `Calculatrice{}` est la seule façon de la construire, et l'écarter rendait
        # la question impossible à noter (« Aucune fonction exploitable »).
        if entries is not None:
            field_list[typ] = entries
    return field_list


def go_pointer_methods(source):
    """Méthodes à RÉCEPTEUR POINTEUR → {(type, méthode)}. FONCTION PURE (testée).

    Une telle méthode peut modifier l'objet. La capture de champs reconstruit l'objet chez
    l'étudiant à chaque appel : le bouchon d'une méthode à récepteur pointeur RELIT donc les
    champs après l'appel et les recopie dans l'objet du harnais (cf. go_object_stub), sans quoi
    la modification serait perdue EN SILENCE."""
    return {(receiver, ident)
            for star, receiver, ident, _, _ in go_methods(source) if star}


def go_capture_fields(source):
    """Champs CAPTURABLES : ceux des structures aux champs tous marshalables. PURE (testée).

    Décision prise ICI et nulle part ailleurs : bouchon, aiguillage et lecture d'API doivent
    s'accorder, sinon un type est miroité d'un côté et traité par poignée de l'autre.

    Un récepteur pointeur n'écarte PLUS la capture : c'est l'étudiant qui choisit son récepteur,
    et `func (r *Rectangle) aire() int` — réponse juste à un harnais qui construit par littéral —
    était notée 0 (« Aucune fonction exploitable »). La modification éventuelle de l'objet est
    reportée par relecture des champs (go_pointer_methods)."""
    return go_struct_fields(source)


def go_object_stub(obj_list, field_list=None, pointer_methods=None):
    """Bouchons OBJET Go : littéral à champs capturés ou poignée, et méthodes relayées.

    `pointer_methods` ({(type, méthode)}, cf. go_pointer_methods) : en capture de champs, ces
    méthodes gardent leur récepteur POINTEUR et recopient dans l'objet du harnais les champs
    relus chez l'étudiant après l'appel.

    FONCTION PURE (testée). Quand tous les champs sont marshalables, le bouchon les MIROITE :
    le harnais écrit son littéral habituel, et la méthode construit l'objet CHEZ l'étudiant au
    moment de l'appel. Une fonction-constructeur reste proxifiée dans ce mode — elle s'exécute
    chez l'étudiant et le bouchon RELIT les champs du résultat, ce qui garde la valeur simple et
    autorise aussi bien `NewRectangle(3, 4)` que le littéral. Sinon : poignée du constructeur."""
    field_list = field_list or {}
    pointer_methods = pointer_methods or frozenset()
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
                # Sans champ, rien à relire : une variable `champs` inutilisée ferait refuser
                # le noteur par le compilateur Go.
                pieces.append('''func %s(%s) %s%s {
    %s mooditChamps("%s", []interface{}{%s})
    return %s%s{%s}
}''' % (ident, params, "*" if pointer else "", typ,
        "champs :=" if field_list[typ] else "_ =", ident, args,
        "&" if pointer else "", typ, reads))
            vals = ", ".join("o.%s" % n for n, _ in field_list[typ])
            for ret, ident, types in method_list:
                params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
                args = ", ".join("a%d" % i for i in range(len(types)))
                pointer = (typ, ident) in pointer_methods
                if pointer and field_list[typ]:
                    # Récepteur POINTEUR : la méthode peut modifier l'objet. On relit ses champs
                    # chez l'étudiant APRÈS l'appel, et on les recopie dans l'objet du harnais.
                    writes = "\n".join(
                        "    o.%s = %s" % (n, GO_CONV[t] % ("mooditIndex(moodit_c, %d)" % i))
                        for i, (n, t) in enumerate(field_list[typ]))
                    pieces.append('''func (o *%s) %s(%s) %s {
    moodit_h := int(mooditEntier(mooditNouvelle("%s", []interface{}{%s})))
    moodit_v := mooditMethode(moodit_h, "%s.%s", []interface{}{%s})
    moodit_c, _ := mooditMethode(moodit_h, "%s.#champs", []interface{}{}).([]interface{})
%s
    return %s
}''' % (typ, ident, params, ret, typ, vals, typ, ident, args, typ, writes,
        GO_CONV[ret] % "moodit_v"))
                    continue
                conv = GO_CONV[ret] % (
                    'mooditMethode(int(mooditEntier(mooditNouvelle("%s", []interface{}{%s}))), '
                    '"%s.%s", []interface{}{%s})' % (typ, vals, typ, ident, args))
                pieces.append('''func (o %s%s) %s(%s) %s {
    return %s
}''' % ("*" if pointer else "", typ, ident, params, ret, conv))
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
                "%s: %s" % (n, GO_CONV[t] % ("mooditDemande.Args[%d]" % i))
                for i, (n, t) in enumerate(field_list[typ]))
            new_branch.append('        case "%s":\n'
                           '            mooditObjets = append(mooditObjets, &%s{%s})\n'
                           '            mooditValeur = len(mooditObjets) - 1'
                           % (typ, typ, assignments))
            # Une fonction-constructeur renvoie les CHAMPS du résultat, pas une poignée : le
            # bouchon reconstruit alors une valeur simple, utilisable comme un littéral.
            for ident, types, _ in ctors:
                args = ", ".join(GO_CONV[t] % ("mooditDemande.Args[%d]" % i) for i, t in enumerate(types))
                return_fields = ", ".join("moodit_cree.%s" % n for n, _ in field_list[typ])
                new_branch.append('        case "%s":\n'
                               '            moodit_cree := %s(%s)\n'
                               '            _ = moodit_cree\n'
                               '            mooditValeur = []interface{}{%s}'
                               % (ident, ident, args, return_fields))
            # Relecture des champs après une méthode à récepteur pointeur (cf. go_object_stub).
            # `#` ne peut pas figurer dans un nom de méthode : aucune collision possible.
            if field_list[typ]:
                method_branch.append(
                    '        case "%s.#champs":\n'
                    '            moodit_lu := mooditObjets[mooditDemande.Handle].(*%s)\n'
                    '            mooditValeur = []interface{}{%s}'
                    % (typ, typ, ", ".join("moodit_lu.%s" % n for n, _ in field_list[typ])))
        else:
            # On garde un POINTEUR vers l'objet : une méthode à récepteur pointeur — l'idiome le
            # plus répandu — ne peut pas être appelée sur le résultat d'une assertion de type,
            # qui n'est pas adressable. Le programme de l'étudiant ne compilait pas, et il lisait
            # « Échec de compilation » pour du code qu'il n'avait pas écrit.
            for ident, types, pointer in ctors:
                args = ", ".join(GO_CONV[t] % ("mooditDemande.Args[%d]" % i) for i, t in enumerate(types))
                new_branch.append('        case "%s":\n'
                               '            moodit_cree := %s(%s)\n'
                               '            mooditObjets = append(mooditObjets, %smoodit_cree)\n'
                               '            mooditValeur = len(mooditObjets) - 1'
                               % (ident, ident, args, "" if pointer else "&"))
        for ret, ident, types in method_list:
            args = ", ".join(GO_CONV[t] % ("mooditDemande.Args[%d]" % i) for i, t in enumerate(types))
            # `(*T)` : un récepteur valeur s'appelle aussi sur un pointeur (déréférencement
            # automatique), donc une seule forme suffit pour les deux.
            method_branch.append('        case "%s.%s":\n'
                               '            mooditValeur = mooditObjets[mooditDemande.Handle].(*%s).%s(%s)'
                               % (typ, ident, typ, ident, args))
    return "\n".join(new_branch), "\n".join(method_branch)


def go_grader_source(methods, harness_code, nonce, obj_list=(), field_list=None,
                     pointer_methods=None):
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
''', GO_GRADER_ALIASED) % (GO_RPC_RUNTIME, "\n\n".join(stubs),
                           go_object_stub(obj_list, field_list, pointer_methods),
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
        # Locales du serveur PRÉFIXÉES `moodit` : Go n'a pas de chemin qualifié vers son propre
        # paquet, et une locale masque une fonction du même nom. Avec `valeur`, `req`, `ligne`…,
        # une `func valeur(n int) int` soumise donnait `valeur = valeur(…)` sur un interface{}
        # — « Échec de compilation » sur une réponse juste.
        args = ", ".join(GO_CONV[t] % ("mooditDemande.Args[%d]" % i)
                         for i, t in enumerate(types))
        branches.append('        case "%s":\n            mooditValeur = %s(%s)'
                        % (ident, ident, args))
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
    mooditLecteur := bufio.NewReader(os.Stdin)
    for {
        mooditLigne, mooditErr := mooditLecteur.ReadString('\\n')
        if mooditErr != nil {
            return
        }
        var mooditDemande mooditReq
        mooditDec := json.NewDecoder(strings.NewReader(mooditLigne))
        mooditDec.UseNumber()
        if mooditDec.Decode(&mooditDemande) != nil {
            continue
        }
        mooditReponse := mooditRep{Ok: true, Id: mooditDemande.Id}
        func() {
            defer func() {
                if r := recover(); r != nil {
                    mooditReponse = mooditRep{Ok: false, Id: mooditDemande.Id, Error: fmt.Sprint(r)}
                }
            }()
            var mooditValeur interface{}
            if mooditDemande.Op == "new" {
                switch mooditDemande.Name {
%s
                default:
                    panic("constructeur inconnu : " + mooditDemande.Name)
                }
            } else if mooditDemande.Op == "method" {
                switch mooditDemande.Name {
%s
                default:
                    panic("methode inconnue : " + mooditDemande.Name)
                }
            } else {
                switch mooditDemande.Name {
%s
                default:
                    panic("fonction inconnue : " + mooditDemande.Name)
                }
            }
            mooditReponse.Value = mooditValeur
        }()
        brut, errRep := json.Marshal(mooditReponse)
        if errRep != nil {
            // Meme motif que cote noteur : une valeur non representable (NaN, Inf) rendue par le
            // code soumis ne doit pas bloquer le couple, mais etre refusee explicitement.
            brut, _ = json.Marshal(mooditRep{Ok: false, Id: mooditDemande.Id,
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
# Qualificatifs bornes a huit, comme CS_MODS : leur `\s+` franchit les fins de ligne, et une
# source faite de `const` un par ligne faisait repartir le motif de chaque ligne jusqu'au bout
# (temps quadratique : 8 s par cas pour 100 000 caracteres).
# Qualificatifs et attributs d'une fonction libre : `constexpr int f(int)`, `[[nodiscard]] int
# f(int)`, `int f(int) noexcept` étaient ignorés — « Aucune fonction exploitable », 0 sur une
# réponse juste. Attributs bornés (pas de retour arrière coûteux).
C_ATTRIBUTES = r"(?:\[\[[^\[\]\n]{0,80}\]\]\s*)*"
# Écritures d'un même type scalaire : `long int` est un `long`, `signed` un `int` (revue #246 :
# non reconnues, la fonction n'était pas proxifiée). `long long`, `long double`, `unsigned`
# restent hors liste (types non transportables). Plus longue d'abord.
C_SCALAR_RET = (r"(?:signed\s+)?long(?:\s+signed)?(?:\s+int)?(?!\s+(?:long|double)\b)"
                r"|signed(?:\s+int)?|int|double")
C_FUNC = re.compile(r"^[ \t]*" + C_ATTRIBUTES
                    + r"(?:(?:static|inline|extern|const|constexpr|consteval)\s+){0,8}"
                    r"(" + C_SCALAR_RET + r"|float|char\s*\*)\s+(\w+)\s*\(([^()]*)\)"
                    r"\s*(?:noexcept(?:\s*\([^()]*\))?\s*)?\{", re.M)
# PROTOTYPE de premier niveau (`int somme(int n, int acc = 0);`) : en C++, la valeur par défaut
# ne s'écrit qu'une fois, souvent là (prototype en haut, définitions après `main`).
C_PROTO = re.compile(r"^[ \t]*" + C_ATTRIBUTES
                     + r"(?:(?:static|inline|extern|const|constexpr|consteval)\s+){0,8}"
                     r"(" + C_SCALAR_RET + r")\s+(\w+)\s*\(([^()]*)\)"
                     r"\s*(?:noexcept(?:\s*\([^()]*\))?\s*)?;", re.M)
# Retour en fin de signature (C++) : `auto f(int x) -> int {`.
C_FUNC_TRAILING = re.compile(r"^[ \t]*" + C_ATTRIBUTES
                             + r"(?:(?:static|inline|constexpr|consteval)\s+){0,8}"
                             r"auto\s+(\w+)\s*\(([^()]*)\)\s*(?:noexcept(?:\s*\([^()]*\))?\s*)?"
                             r"->\s*(int|long|double)\s*\{", re.M)
# `%.17g` et non `%g` : ce format est celui des ARGUMENTS comme des RETOURS, relus par atof.
# `%g` s'arrête à 6 chiffres significatifs — 3.14159265 arrivait tronqué chez l'étudiant et
# 1234567.89 revenait en notation exponentielle, donc une réponse JUSTE était notée fausse.
# 17 chiffres suffisent à garantir l'aller-retour exact d'un double IEEE 754.
C_TYPES = {"int": "%d", "long": "%ld", "double": "%.17g"}


def c_scalar_type(text):
    """`long int` → `long`, `signed` → `int`… ; None hors des trois types transportables. PURE."""
    words = (text or "").split()
    if words == ["double"]:
        return "double"
    if not words or any(w not in ("signed", "long", "int") for w in words):
        return None
    if words.count("long") > 1 or words.count("int") > 1 or words.count("signed") > 1:
        return None
    return "long" if "long" in words else "int"
# Mots qui composent un type C/C++ : en deuxieme position, ils ne sont pas un NOM de parametre.
C_TYPE_WORDS = {"int", "long", "double", "short", "unsigned", "signed", "char", "float", "bool",
                "void", "auto", "wchar_t"}
# Lecture d'un champ texte, UNE seule fois pour les cinq sites qui en avaient une copie.
C_READ = {"int": "atoi", "long": "atol", "double": "atof"}


# Un littéral de caractère, et RIEN d'autre : 'x', '\n', '\u{1F600}'. Tout le reste —
# durée de vie Rust, étiquette de boucle, séparateur de chiffres C++ — est une apostrophe
# ordinaire, qui n'ouvre aucun littéral : la prendre pour une ouverture faisait ignorer les
# accolades jusqu'à la fin de la ligne et décalait le compteur pour tout le reste du fichier.
CHAR_LITERAL = re.compile(r"'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'")


RAW_STRING_RUST = re.compile(r'r(#*)"')
RAW_STRING_CPP = re.compile(r'R"\(')


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
        # Motif ancré à la POSITION (match(texte, i)) et tenté sur `r`/`R` seulement : la version
        # précédente découpait src_text[i:] à CHAQUE caractère, soit une copie du reste du
        # fichier par position — quadratique, 6 s pour 100 000 caractères de code soumis (12 s
        # sur une entrée hostile), refaites à chaque cas de la question.
        raw = (RAW_STRING_RUST.match(src_text, i) if c == "r"
               else RAW_STRING_CPP.match(src_text, i) if c == "R" else None)
        if raw:
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


# Espace de noms NOMMÉ (`namespace util {`, `namespace a::b {`). L'anonyme (`namespace {`) n'en
# est pas : ses membres se nomment sans qualification, `::f` les atteint.
CPP_NAMESPACE = re.compile(r"\bnamespace\s+\w+(?:\s*::\s*\w+)*\s*\{")


def cpp_namespace_spans(source):
    """Plages (début, fin) des corps d'espaces de noms NOMMÉS en C++. FONCTION PURE (testée).

    Une fonction ou une classe qui y vit ne s'écrit que `util::f` : le serveur généré, qui
    l'appelait `::f`, ne compilait plus — « Échec de compilation » sur tous les cas d'une
    réponse juste, avec une erreur dans du code que l'étudiant n'a pas écrit. Elle n'est donc
    pas proxifiée (comme une fonction imbriquée en Rust) ; le reste du fichier l'est toujours."""
    src_text = source or ""
    return [(m.end() - 1, block_end(src_text, m.end() - 1))
            for m in CPP_NAMESPACE.finditer(src_text)]


def span_cover(spans):
    """Index de plages pour `covered` : (débuts triés, plus grande fin atteinte). PURE (testée)."""
    ordered = sorted(spans)
    reach, furthest = [], -1
    for _, finish in ordered:
        furthest = max(furthest, finish)
        reach.append(furthest)
    return [begin for begin, _ in ordered], reach


def covered(cover, position):
    """La position est-elle STRICTEMENT dans l'une des plages de l'index ? PURE (testée).

    Par dichotomie : comparer chaque déclaration à chaque plage coûtait le produit des deux —
    des milliers de classes vides tenaient l'extraction plusieurs secondes par cas."""
    begins, reach = cover
    k = bisect.bisect_left(begins, position)
    return k > 0 and reach[k - 1] > position


def c_signatures(source, cpp=False):
    """Fonctions de premier niveau du code étudiant → [(retour, nom, [types])]. PURE (testée).

    Seuls int/long/double sont marshalés dans ce jalon ; `main` est écartée, ainsi que — en C++ —
    tout ce qui vit dans un corps de classe (ce sont des méthodes, proxifiées par poignée) ou
    dans un espace de noms nommé (cf. cpp_namespace_spans). Une signature hors liste n'est pas
    proxifiée : le harnais qui l'appelle ne compilera pas (message au prof, jamais un faux
    verdict)."""
    cover = span_cover(cpp_class_spans(source) + cpp_namespace_spans(source) if cpp else [])
    hits = []
    found = [(h.start(), h.group(1), h.group(2), h.group(3)) for h in C_FUNC.finditer(source or "")]
    if cpp:
        found += [(h.start(), h.group(3), h.group(1), h.group(2))
                  for h in C_FUNC_TRAILING.finditer(source or "")]
        found.sort()
    # Valeurs par défaut portées par un PROTOTYPE (C++) : reportées sur la définition de même
    # nom et mêmes types, qui n'en porte pas (revue #246 : `somme(4)` ne compilait pas dans le
    # noteur, 0 sur une réponse juste).
    proto_defaults = {}
    if cpp:
        for proto in C_PROTO.finditer(source or ""):
            proto_types = _c_param_types(proto.group(3))
            if not covered(cover, proto.start()) and proto_types is not None:
                key = (proto.group(2), tuple(proto_types))
                proto_defaults[key] = max(proto_defaults.get(key, 0),
                                          trailing_defaults(proto.group(3)))
    for start, ret, ident, params in found:
        if covered(cover, start):
            continue
        ret = c_scalar_type(ret) or ret.replace(" ", "")
        if ident == "main" or ret not in C_TYPES:
            continue
        # Le MEME lecteur que le chemin objet C++ (_c_param_types) : deux copies divergeaient.
        types = _c_param_types(params)
        if types is None:
            continue
        defaults = max(trailing_defaults(params),
                       proto_defaults.get((ident, tuple(types)), 0)) if cpp else 0
        hits.append((ret, ident, types, defaults))
    hits = with_default_arities(hits)
    # Une fonction definie dans deux branches du preprocesseur (`#if … #else …`) etait vue deux
    # fois : deux bouchons identiques, « redefinition of moodit_f_… », 0 sur une reponse juste.
    # Une seule fois par NOM en C (pas de surcharge), par nom ET types en C++.
    if cpp:
        return dedupe_signatures(hits)
    seen, unique = set(), []
    for hit in hits:
        if hit[1] not in seen:
            seen.add(hit[1])
            unique.append(hit)
    return unique


CPP_QUALIF = re.compile(r"^(?:(?:explicit|virtual|inline|constexpr)\s+|\[\[[^\[\]\n]{0,80}\]\]\s*)+")
CPP_CLASS = re.compile(r"^[ \t]*(?:class|struct)\s+(\w+)", re.M)
# Debut d'un `template <...>`, et fins d'instruction ou de bloc : cf. cpp_follows_template.
CPP_TEMPLATE_HEAD = re.compile(r"\btemplate\s*<")
CPP_STATEMENT_END = re.compile(r"[{};]")


def cpp_follows_template(src_text, position, heads, bounds):
    """Un `template <...>` PRECEDE-t-il immediatement la declaration en `position` ? PURE (testee).

    Vrai si le texte qui la precede finit par `>` et qu'un `template <` s'ouvre depuis la
    derniere fin d'instruction ou de bloc. `heads` et `bounds` sont les positions, calculees UNE
    fois, de CPP_TEMPLATE_HEAD et de CPP_STATEMENT_END.

    L'ancien motif (`template\\s*<[^{};]*>\\s*\\Z`) etait relance sur tout le texte precedent, a
    chaque classe, et repartait de chaque `template<` jusqu'au bout : cout CUBIQUE, dans le
    superviseur, avant toute compilation et hors de tout delai. 39 Ko de `template<` suivis de
    classes tenaient un cas plus de cinq minutes, le conteneur etait tue au mur (502,
    tentative supprimee, place de correction occupee tout ce temps)."""
    finish = position
    while finish > 0 and src_text[finish - 1].isspace():
        finish -= 1
    if finish == 0 or src_text[finish - 1] != ">":
        return False
    k = bisect.bisect_left(bounds, position)
    last_bound = bounds[k - 1] if k else -1
    h = bisect.bisect_left(heads, position)
    return h > 0 and heads[h - 1] > last_bound
# Methode virtuelle PURE : `= 0;` apres la parenthese fermante (et ses qualificatifs).
CPP_PURE_VIRTUAL = re.compile(r"\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?=\s*0\s*;")


def cpp_class_body_start(src_text, head_end, bounds):
    """Position de l'accolade ouvrante du corps d'une classe, ou -1 si l'en-tête n'en a pas.
    FONCTION PURE (testée).

    Le corps est celui de CET en-tête seulement si son `{` est le premier de `{`, `}`, `;` après
    lui (`bounds`, positions triées de CPP_STATEMENT_END) et qu'aucun autre EN-TÊTE `class` /
    `struct` (en début de ligne) ne s'intercale. L'ancienne recherche — « la première accolade après l'en-tête » —
    donnait la MÊME accolade à tous les en-têtes sans corps qui la précèdent : 6 000 lignes
    `class A` suivies d'un seul corps de 50 Ko le faisaient redécouper 6 000 fois, caractère par
    caractère (plus de 90 s par cas pour une source de 100 Ko, hors de tout délai par phase).
    Elle attribuait aussi à une déclaration anticipée (`class B;`) le corps de la classe
    suivante, d'où un bouchon `B` qui ne compilait pas."""
    k = bisect.bisect_left(bounds, head_end)
    if k == len(bounds) or src_text[bounds[k]] != "{":
        return -1
    begin = bounds[k]
    # Autre EN-TETE (meme motif que CPP_CLASS : mot-cle en debut de ligne), pas un simple
    # mot-cle : `class A : public Base<struct Tag> {` porte `struct` dans sa clause de base, et
    # la classe n'etait plus proxifiee — reponse juste notee 0.
    if CPP_CLASS.search(src_text, head_end, begin):
        return -1
    return begin


def cpp_object_api(source):
    """API OBJET C++ → [(classe, [constructeurs], [(retour, méthode, [types])])]. PURE (testée).

    Le corps de la classe est découpé par appariement d'accolades, et seules les déclarations de
    la section PUBLIQUE comptent (une `class` commence en privé, une `struct` en public)."""
    src_text = source or ""
    found = []            # (classe, constructeurs, méthodes, instanciable), dans l'ordre du source
    apis, parents, hiding = {}, {}, {}
    # Première base de chaque dérivée (tout accès), dérivées qui reprennent les constructeurs de
    # leur base (`using Forme::Forme;`) et classes qui n'en déclarent aucun : de quoi leur donner,
    # après coup, les constructeurs que C++ leur fournit (voir la fin).
    bases, inheriting_ctors = {}, set()
    cover = span_cover(cpp_class_spans(src_text) + cpp_namespace_spans(src_text))
    heads = [m.start() for m in CPP_TEMPLATE_HEAD.finditer(src_text)]
    bounds = [m.start() for m in CPP_STATEMENT_END.finditer(src_text)]
    for klass in CPP_CLASS.finditer(src_text):
        class_ident = klass.group(1)
        # Classe IMBRIQUEE : elle ne s'ecrit que `A::B`, et le serveur, qui la nomme `B`, ne
        # compilait plus. Elle n'est pas proxifiee (ni ses membres pris pour ceux de A). Meme
        # chose pour une classe d'un espace de noms NOMME (`util::B`).
        if covered(cover, klass.start()):
            continue
        # Classe TEMPLATE (`template <typename T>` sur la ligne precedente) : `std::vector<K>`
        # sans argument de template ne compile pas. Non proxifiee, comme les generiques en C#.
        if cpp_follows_template(src_text, klass.start(), heads, bounds):
            continue
        begin = cpp_class_body_start(src_text, klass.end(), bounds)
        if begin < 0:
            continue
        finish = block_end(src_text, begin)
        body = src_text[begin + 1:finish]
        # Classe ABSTRAITE (une methode virtuelle pure) : elle ne s'instancie pas, et le
        # `push_back(K(...))` de l'aiguillage faisait refuser tout le programme de l'etudiant
        # (« Echec de compilation » sur un exercice d'heritage juste). Elle n'est pas proxifiee,
        # mais ses methodes publiques comptent pour ses classes derivees (heritage).
        abstract = bool(CPP_PURE_VIRTUAL.search(body))
        is_struct = src_text[klass.start():begin].lstrip().startswith("struct")
        public = is_struct
        # Base PUBLIQUE (`: public Forme`, ou toute base d'une struct) : ses methodes publiques
        # s'appellent sur la derivee. L'heritage d'une `class` est PRIVE par defaut.
        # `final` avant la liste des bases, `virtual` avant OU après l'accès : `class Carre final
        # : public Forme` n'enregistrait pas sa base, et ses méthodes héritées manquaient.
        base = re.match(r"\s*(?:final\s*)?:\s*(?:virtual\s+)?(public|protected|private)?\s*"
                        r"(?:virtual\s+)?(\w+)", src_text[klass.end():begin])
        if base:
            bases[class_ident] = base.group(2)
        if base and (base.group(1) == "public" or (base.group(1) is None and is_struct)):
            parents[class_ident] = base.group(2)
        ctors, method_list, ctor_entries = [], [], []
        declared_names, unhidden = set(), set()
        declares_ctor = False
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
            # Étiquette d'accès, espace avant le `:` admis (`public :`), jamais `public::x`.
            label = re.match(r"(public|private|protected)\s*:(?!:)", bare_line)
            if label:
                public = label.group(1) == "public"
                bare_line = bare_line[label.end():].strip()
            # Noms de methodes DECLARES, toutes sections et tous types : ils masquent ceux de la
            # base (cf. inherit_instance_methods). Lus dans la TETE de declaration seulement :
            # un appel `aire()` dans le corps d'une autre methode ne declare rien.
            # Jusqu'au premier `=` : `int c = f(2);` initialise un champ, il ne declare pas `f`
            # (un argument par defaut `f(int a = 3)` garde, lui, son nom avant le `=`).
            head = CPP_QUALIF.sub("", bare_line.split("{", 1)[0].split("=", 1)[0])
            using = re.match(r"using\s+[\w:]+::(\w+)\s*;", bare_line)
            if using:
                unhidden.add(using.group(1))
                # `using Forme::Forme;` : les constructeurs de la base deviennent ceux de la
                # dérivée (avec leur accès), qui n'était sinon pas proxifiée.
                if base and using.group(1) == base.group(2):
                    inheriting_ctors.add(class_ident)
            else:
                declared = re.search(r"(~?\w+)\s*\(", head)
                if declared and declared.group(1) not in (class_ident, "~" + class_ident, "operator"):
                    declared_names.add(declared.group(1))
            # Un constructeur DECLARE, meme prive ou non transportable, retire le constructeur
            # par defaut implicite (voir plus bas).
            if re.match(re.escape(class_ident) + r"\s*\(", CPP_QUALIF.sub("", bare_line)):
                declares_ctor = True
            if not public or not bare_line:
                continue
            # Qualificatifs sans effet sur la signature vue de l'appelant.
            bare_line = CPP_QUALIF.sub("", bare_line)
            ctor = re.match(re.escape(class_ident) + r"\s*\(([^()]*)\)", bare_line)
            if ctor:
                types = _c_param_types(ctor.group(1))
                if types is not None:
                    ctor_entries.append((None, class_ident, types, trailing_defaults(ctor.group(1))))
                continue
            meth = re.match(r"(" + C_SCALAR_RET + r")\s+(\w+)\s*\(([^()]*)\)", bare_line)
            # `int operator()(int)` : un opérateur n'est pas une méthode nommée `operator` — le
            # serveur générait `->operator()`, qui ne compilait pas même sans que le harnais
            # nomme la classe.
            if meth and meth.group(2) == "operator":
                meth = None
            if meth:
                types = _c_param_types(meth.group(3))
                if types is not None:
                    method_list.append((c_scalar_type(meth.group(1)), meth.group(2), types,
                                        trailing_defaults(meth.group(3))))
        ctors = [types for _r, _n, types in with_default_arities(ctor_entries)]
        method_list = with_default_arities(method_list)
        # AUCUN constructeur declare : C++ fournit le constructeur par defaut, comme Java et
        # C#. Sans lui, `Calculatrice c; c.additionner(2, 3)` n'etait pas notable. Pas pour une
        # classe DERIVEE : sa construction par defaut depend de celle de sa base, et un `K()`
        # genere qui ne compile pas casserait le programme de l'etudiant.
        # DÉRIVÉE comprise : le serveur construit par moodit_cree, qui vérifie à la compilation
        # que la classe se construit ainsi (base au constructeur protégé, base sans constructeur
        # par défaut) et répond une erreur sinon — un `new K()` impossible ne casse plus le
        # programme de l'étudiant.
        if not declares_ctor:
            ctors = [[]]
        if class_ident not in apis:
            apis[class_ident] = (ctors, method_list)
            hiding[class_ident] = declared_names - unhidden
            found.append((class_ident, ctors, not abstract))
    # Methodes HERITEES d'une base publique du code soumis : `Carre c(3); c.aire()` avec un
    # `aire()` de `Forme` compile cote serveur (recherche de nom C++), mais le bouchon ne le
    # portait pas — et une derivee sans methode propre n'etait meme pas proxifiee (« 'Carre'
    # was not declared »). 0 sur une reponse juste qui herite au lieu de redefinir.
    merged = inherit_instance_methods(apis, parents, hiding)
    # Constructeurs qu'une DÉRIVÉE reprend de sa base du code soumis par `using Base::Base;`
    # (ceux, publics, que la base déclare). Jusqu'à stabilité, pour les chaînes de dérivation.
    # 0 sur une réponse juste sinon : « 'Carre' was not declared ».
    changed = True
    while changed:
        changed = False
        for name, (ctors, _methods) in apis.items():
            base_api = apis.get(bases.get(name))
            if base_api is None or name not in inheriting_ctors:
                continue
            for types in [t for t in base_api[0] if t]:
                if types not in ctors:
                    ctors.append(types)
                    changed = True
    return [(name, ctors, merged[name]) for name, ctors, concrete in found
            if concrete and ctors and merged[name]]


def _member_pieces(body, offset, depths, level):
    """Corps de classe découpé en morceaux d'au plus UN membre chacun. FONCTION PURE (testée).

    Coupe aux fins de ligne ET après chaque `;` ou `}` du niveau de la classe : sans cela, deux
    membres sur une même ligne (`Rect(int w):w(w) {} int aire() {…}`) n'étaient vus que par le
    premier, le constructeur faisait sauter la ligne, la méthode n'était pas proxifiée et une
    réponse juste notait 0. `offset` est la position de `body` dans le source, `depths` vient de
    code_depths (une `}` porte la profondeur APRÈS sa fermeture). Les morceaux, mis bout à bout,
    redonnent `body`.

    Une fin de ligne ne coupe qu'à parenthèses ÉQUILIBRÉES : un membre déclaré sur plusieurs
    lignes (`Rect(int largeur,` puis `int hauteur)`) était coupé en deux, le constructeur vu comme
    déclaré mais pas lu, et la classe n'était plus proxifiée — 0 sur une réponse juste. Ni
    après une ligne qui n'est qu'une TÊTE de déclaration (`int`, `[[nodiscard]]`, `virtual`,
    puis le nom et les paramètres à la ligne suivante) : sans parenthèse, `;`, accolade, `=`
    ni `:` (étiquette d'accès), et pas une directive du préprocesseur."""
    pieces = []
    start = 0
    parens = 0
    for i, c in enumerate(body):
        if c == "(":
            parens += 1
        elif c == ")" and parens > 0:
            parens -= 1
        head = body[start:i].strip() if c == chr(10) and parens == 0 else ""
        only_head = (bool(head) and not head.startswith("#")
                     and not any(ch in head for ch in "();{}=:"))
        cut = ((c == chr(10) and parens == 0 and not only_head)
               or (c in ";}" and depths[offset + i] == level))
        if cut:
            pieces.append(body[start:i + 1])
            start = i + 1
            parens = 0
    if start < len(body):
        pieces.append(body[start:])
    return pieces


def _c_param_types(params):
    """Types des parametres d'une signature C/C++, ou None si l'un n'est pas marshalable. PURE.

    SEUL lecteur de parametres C/C++, pour les fonctions libres comme pour le chemin objet : deux
    copies divergeaient (les pointeurs etaient ecartes dans l'une, pris pour un scalaire dans
    l'autre). Pointeur, tableau ou reference -> None (pas de bouchon : `int *tab` n'est pas
    `int`). `const` est ignore : `const int n` est un `int` pour l'appelant. La valeur par defaut
    (`int b = 0`, C++) ne change pas le type vu par l'appelant : coupee, comme en C#
    (_cs_param_types). Lue comme un morceau de plus, elle ecartait la fonction — et, pour un
    constructeur, la classe entiere : une reponse juste etait notee 0."""
    types = []
    for param_group in [p.strip() for p in params.split(",") if p.strip() and p.strip() != "void"]:
        # Référence CONSTANTE (`const int& x`) : le serveur passe une variable, qui s'y lie ; le
        # type vu par l'appelant est le scalaire. Pas `int&` non constante : le bouchon passe
        # par valeur, et une modification attendue par le harnais (`echange(a, b)`) serait
        # perdue sans bruit — écartée, le harnais qui l'appelle ne compile pas (message au prof).
        # Pas `&&` (une variable ne s'y lie pas), ni pointeur ni tableau.
        if any(c in param_group for c in "*[") or "&&" in param_group:
            return None
        if "&" in param_group:
            if "const" not in param_group.split("=")[0].split("&")[0].split():
                return None
            param_group = param_group.replace("&", " ")
        pieces = [m for m in param_group.split("=")[0].split() if m != "const"]
        # Un type SEUL (parametre sans nom : `Rect(int, int);`, declaration dans la classe et
        # definition dehors — l'ecriture C++ la plus courante), ou un type et un NOM. Le type
        # peut s'ecrire en plusieurs mots (`long int`, `signed`) ; `long double`, `unsigned int`
        # et `long long` ne sont pas transportables : `long double` passait pour un `long`, le
        # bouchon tronquait 2.5 a 2, faux verdict muet.
        n_words = 0
        while n_words < len(pieces) and pieces[n_words] in C_TYPE_WORDS:
            n_words += 1
        scalar = c_scalar_type(" ".join(pieces[:n_words]))
        if scalar is None or len(pieces) - n_words > 1:
            return None
        types.append(scalar)
    return types


def cpp_object_stub(obj_list):
    """Bouchons OBJET C++ : classe à poignée, constructeurs et méthodes relayés. PURE (testée).

    Les fonctions de la libc sont appelées QUALIFIÉES (`::atoi`, `::snprintf`) : dans le corps
    d'un membre, une méthode soumise du même nom l'emportait sur la fonction globale."""
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
                      '        ::snprintf(requete, sizeof requete, "%%s|new|%s%s", id%s);'
                      % (c_dispatch_key(klass, types), fmt, args),
                      "        moodit_envoie(requete);",
                      "        __h = ::atoi(moodit_valeur(id));",
                      "    }"]
        for ret, ident, types in method_list:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            fmt = "".join("|" + C_TYPES[t] for t in types)
            args = "".join(", a%d" % i for i in range(len(types)))
            reader = C_READ[ret]
            body += ["    %s %s(%s) {" % (ret, ident, params),
                      "        char id[40], requete[4096];",
                      "        moodit_identifiant(id);",
                      '        ::snprintf(requete, sizeof requete, "%%s|method|%s.%s|%%d%s", id, __h%s);'
                      % (klass, c_dispatch_key(ident, types), fmt, args),
                      "        moodit_envoie(requete);",
                      "        return ::%s(moodit_valeur(id));" % reader,
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


# Mots-clés dont le serveur se sert, débarrassés d'une macro du code soumis du même nom :
# `#define int long long` (idiome de programmation compétitive) débordait sur le serveur,
# « 'long long long' is too long », 0 sur une réponse juste. Les retours sont convertis vers
# le type annoncé (`(int) f(…)`) : la fonction de l'étudiant rend alors un `long long`.
C_SERVER_KEYWORDS = ("static", "extern", "const", "char", "int", "long", "double", "void", "if",
                     "else", "return", "while", "for", "sizeof", "new", "template", "class",
                     "constexpr")

# Lecture d'un argument côté SERVEUR : fonctions du runtime sans en-tête (C_SERVER_RUNTIME).
C_SERVER_READ = {"int": "moodit_lit_int", "long": "moodit_lit_long", "double": "moodit_lit_double"}


def cpp_object_dispatch(obj_list):
    """Aiguillage OBJET côté étudiant : une table PAR CLASSE, construction réelle. PURE (testée).

    Table de pointeurs et `new`, sans `<vector>` : le serveur n'inclut AUCUN en-tête (cf.
    C_SERVER_RUNTIME), et `new K(…)` ne demande à la classe ni copie ni déplacement."""
    stacks, branches = [], []
    if obj_list:
        # Construction VÉRIFIÉE à la compilation : une classe restée abstraite sans le déclarer
        # (`Polygone` hérite d'un `aire() = 0` qu'elle ne redéfinit pas), ou dont le
        # constructeur demandé n'est pas accessible, rendait `new K(…)` illégal — « Échec de
        # compilation » dans du code que l'étudiant n'a pas écrit, 0 sur une réponse juste. Le
        # trait intégré de gcc évite tout en-tête ; la branche écartée n'est pas instanciée.
        # `moodit_A&...` : les arguments passés sont des VARIABLES (lvalues), comme dans
        # `new moodit_K(moodit_x...)` ; tester des rvalues refusait à tort `Rect(int&, int&)`.
        stacks.append("template <class moodit_K, class... moodit_A>\n"
                      "static moodit_K *moodit_cree(moodit_A... moodit_x) {\n"
                      "    if constexpr (__is_constructible(moodit_K, moodit_A&...)) {\n"
                      "        return new moodit_K(moodit_x...);\n"
                      "    } else {\n"
                      "        return 0;\n"
                      "    }\n"
                      "}")
    for klass, ctors, method_list in obj_list:
        # `::K` : avec un `using namespace std;` soumis, une classe `list` ou `pair` était
        # ambiguë pour le serveur ; le nom qualifié désigne celle du code soumis.
        stacks.append("static ::%s **moodit_objets_%s = 0;\nstatic int moodit_n_%s = 0;"
                      % (klass, klass, klass))
        for types in ctors:
            reads = "\n".join(
                "        %s moodit_a%d = %s(moodit_jeton());"
                % (t, i, C_SERVER_READ[t])
                for i, t in enumerate(types))
            args = ", ".join("moodit_a%d" % i for i in range(len(types)))
            branches.append("""    if (moodit_egal(moodit_op, "new") && moodit_egal(moodit_nom, "%s")) {
%s
        ::%s *moodit_o = moodit_cree< ::%s >(%s);
        if (!moodit_o) {
            moodit_printf("\\n%%s|err|construction impossible\\n", moodit_id);
            moodit_fflush(moodit_stdout);
            return;
        }
        moodit_objets_%s = (::%s **) moodit_realloc(
            moodit_objets_%s, (moodit_n_%s + 1) * sizeof(::%s *));
        moodit_objets_%s[moodit_n_%s++] = moodit_o;
        moodit_printf("\\n%%s|ok|%%d\\n", moodit_id, moodit_n_%s - 1);
        moodit_fflush(moodit_stdout);
        return;
    }""" % (c_dispatch_key(klass, types), reads, klass, klass, args, klass, klass, klass, klass,
            klass, klass, klass, klass))
        for ret, ident, types in method_list:
            reads = "\n".join(
                "        %s moodit_a%d = %s(moodit_jeton());"
                % (t, i, C_SERVER_READ[t])
                for i, t in enumerate(types))
            args = ", ".join("moodit_a%d" % i for i in range(len(types)))
            branches.append("""    if (moodit_egal(moodit_op, "method") && moodit_egal(moodit_nom, "%s.%s")) {
        int moodit_h = moodit_lit_int(moodit_jeton());
        if (moodit_h < 0 || moodit_h >= moodit_n_%s) {
            moodit_printf("\\n%%s|err|objet inconnu\\n", moodit_id);
            moodit_fflush(moodit_stdout);
            return;
        }
%s
        moodit_printf("\\n%%s|ok|%s\\n", moodit_id, (%s) moodit_objets_%s[moodit_h]->%s(%s));
        moodit_fflush(moodit_stdout);
        return;
    }""" % (klass, c_dispatch_key(ident, types), klass, reads, C_TYPES[ret], ret, klass, ident,
            args))
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
    par nom pour nommer les fautifs dans le message — C_PROBE_MAX au plus, le reste en UNE
    sonde groupee (cf. c_probe_plan) : le nombre de compilations est borne quel que soit le
    nombre de noms."""
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
    return impl + [n for group in c_probe_plan(names) if not compiles(group) for n in group]


# Sondes INDIVIDUELLES au plus, apres l'echec de la sonde groupee.
C_PROBE_MAX = 8


def c_probe_plan(names):
    """Groupes a sonder apres l'echec de la sonde groupee. FONCTION PURE (testee).

    Les C_PROBE_MAX premiers noms un par un, puis tous les autres en UN groupe : au plus
    C_PROBE_MAX + 1 compilations. Un groupe refuse est rapporte en entier — au-dela de la
    borne, le message nomme donc les candidats, plus forcement le seul fautif."""
    names = list(names)
    groups = [[n] for n in names[:C_PROBE_MAX]]
    if len(names) > C_PROBE_MAX:
        groups.append(names[C_PROBE_MAX:])
    return groups


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


# Runtime du SERVEUR C/C++ : AUCUN en-tête. Le serveur est compilé dans l'unité du code soumis,
# APRÈS lui : tout `#include` y déclarait des centaines de noms que l'étudiant a le droit de
# porter quand il n'inclut pas l'en-tête lui-même — une fonction d'aide `index`, `remove`,
# `div`, `rand`, `select`, `exit`…, un `typedef … uint`, une macro `#define abs(x) …` (essais
# dans l'image : environ 300 noms de stdio/stdlib/string faisaient échouer la compilation d'une
# réponse juste). Les rares fonctions de la libc dont le serveur a besoin sont donc déclarées
# sous un nom `moodit_`, liées au symbole réel par une étiquette d'assembleur (extension gcc et
# g++), et le reste — comparaison, recherche d'un caractère — est écrit ici.
C_SERVER_RUNTIME = r"""
#ifdef __cplusplus
extern "C" {
#endif
extern int moodit_printf(const char *, ...) __asm__("printf");
extern int moodit_fflush(void *) __asm__("fflush");
extern char *moodit_fgets(char *, int, void *) __asm__("fgets");
extern long moodit_strtol(const char *, char **, int) __asm__("strtol");
extern double moodit_strtod(const char *, char **) __asm__("strtod");
extern void *moodit_realloc(void *, __SIZE_TYPE__) __asm__("realloc");
extern void *moodit_stdin __asm__("stdin");
extern void *moodit_stdout __asm__("stdout");
#ifdef __cplusplus
}
#endif

static char moodit_ligne[8192];
static char *moodit_reste;

static int moodit_egal(const char *moodit_x, const char *moodit_y) {
    while (*moodit_x && *moodit_x == *moodit_y) { moodit_x++; moodit_y++; }
    return *moodit_x == *moodit_y;
}

static char *moodit_cherche(char *moodit_x, char moodit_c) {
    for (; *moodit_x; moodit_x++) { if (*moodit_x == moodit_c) { return moodit_x; } }
    return 0;
}

static int moodit_lit_int(const char *moodit_x) { return (int) moodit_strtol(moodit_x, 0, 10); }
static long moodit_lit_long(const char *moodit_x) { return moodit_strtol(moodit_x, 0, 10); }
static double moodit_lit_double(const char *moodit_x) { return moodit_strtod(moodit_x, 0); }

static const char *moodit_jeton(void) {
    if (!moodit_reste) { return "0"; }
    char *moodit_debut = moodit_reste;
    char *moodit_sep = moodit_cherche(moodit_debut, '|');
    if (moodit_sep) { *moodit_sep = 0; moodit_reste = moodit_sep + 1; } else { moodit_reste = 0; }
    return moodit_debut;
}
"""


# Symboles de la libc auxquels le serveur est LIÉ (étiquettes d'assembleur de C_SERVER_RUNTIME),
# et l'allocateur dont ils dépendent. Un code soumis qui DÉFINIT l'un d'eux au niveau du fichier
# le remplace à l'édition de liens pour tout le programme : le serveur écrirait ses réponses
# avec la `printf` de l'étudiant.
C_SERVER_SYMBOLS = ("printf", "fflush", "fgets", "strtol", "strtod", "realloc", "malloc", "calloc",
                    "free", "stdin", "stdout")


def c_symbols_defined_in_binary(nm_lines):
    """Symboles de C_SERVER_SYMBOLS que le BINAIRE du code soumis définit lui-même.

    FONCTION PURE (testée). `nm_lines` : la sortie de `nm --defined-only`, texte ou lignes. Le
    contrôle se fait sur le BINAIRE, pas sur le texte : lire la source refusait à tort une
    méthode `Pile::free`, un `using std::free;` ou une surcharge C++, et laissait passer un type
    de retour sur sa propre ligne, un bloc `extern "C"` ou un paramètre écrit par un alias de
    type. Une surcharge C++ et un membre de classe sont décorés (`_Z4freeP1N`) : ce n'est pas le
    nom. Un nom suivi d'une VERSION n'est celui de la libc que pour une DONNÉE
    (`B stdout@GLIBC_2.2.5`, copie de relocalisation) : un binaire lié dynamiquement ne définit
    aucune fonction de la libc, donc une fonction versionnée (`T free@@GLIBC_2.2.5`, directive
    `.symver`) vient du code soumis, comme un nom nu, local (`t`) ou global (`T`)."""
    if isinstance(nm_lines, str):
        nm_lines = nm_lines.splitlines()
    names = set()
    for line in nm_lines or ():
        parts = line.split()
        if len(parts) < 2:
            continue
        name, _, version = parts[-1].partition("@")
        if name in C_SERVER_SYMBOLS and (not version or parts[-2] in ("T", "t", "W", "w")):
            names.add(name)
    return [n for n in C_SERVER_SYMBOLS if n in names]


def c_binary_linked_symbols(code, expired, nm_out):
    """Symboles de la libc redéfinis, d'après un `nm` TERMINÉ. Testée.

    La sortie est lue EN ENTIER, ligne à ligne : relue par read_capped (tête + queue au-delà de
    64 Kio), une ligne coupée fabriquait un faux nom — `liste_free` devenait `free`, réponse
    honnête refusée — et une vraie redéfinition tombait dans le trou. Le fichier est écrit par
    le superviseur (pompe bornée), hors d'atteinte du code soumis. Si nm a échoué ou expiré, ou
    si sa sortie est illisible : aucun refus. Ce contrôle n'est qu'un diagnostic nommé, à la
    place d'un appel refusé ou d'un temps limite inexpliqué ; il ne protège pas le verdict."""
    if expired or code != 0:
        return []
    try:
        fd = os.open(nm_out, os.O_RDONLY | O_NO_LINK)
        with os.fdopen(fd, "r", encoding="utf-8", errors="replace") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                return []
            return c_symbols_defined_in_binary(f)
    except OSError:
        return []


def c_server_source(methods, student_source, cpp=False, obj_list=()):
    """Programme ÉTUDIANT C/C++ : son code (main renommé) + aiguillage typé. PURE (testée).

    Après le code soumis, le serveur n'emploie QUE des mots-clés, des noms `moodit_` et les
    noms des fonctions et classes soumises (cf. C_SERVER_RUNTIME)."""
    branches = []
    for ret, ident, types in methods:
        reads = []
        for i, t in enumerate(types):
            reads.append("        %s moodit_a%d = %s(moodit_jeton());" % (t, i, C_SERVER_READ[t]))
        # Locales et paramètres PRÉFIXÉS `moodit_` : en C comme en C++, un paramètre masque une
        # fonction du même nom. Avec `id`, `op`, `nom` et `a0`, une `int id(int x)` soumise
        # devenait un appel sur un `const char *` — le programme de l'étudiant ne compilait plus.
        args = ", ".join("moodit_a%d" % i for i in range(len(types)))
        # En C++, appel QUALIFIÉ `::f(…)` : avec un `using namespace std;` soumis, une fonction
        # `divides`, `modulus`, `plus` ou `identity` portait le nom d'un type de la bibliothèque
        # et l'appel nu du serveur était ambigu — la réponse ne compilait plus.
        scope = "::" if cpp else ""
        branches.append("""    if (moodit_egal(moodit_op, "call") && moodit_egal(moodit_nom, "%s")) {
%s
        moodit_printf("\\n%%s|ok|%s\\n", moodit_id, (%s) %s%s(%s));
        moodit_fflush(moodit_stdout);
        return;
    }""" % (c_dispatch_key(ident, types), "\n".join(reads), C_TYPES[ret], ret, scope, ident,
            args))
    stacks, object_branches = cpp_object_dispatch(obj_list)
    return ("#define main __moodit_student_main\n"
            + (student_source or "")
            + "\n#undef main\n"
            + "".join("#undef %s\n" % word for word in C_SERVER_KEYWORDS)
            + C_SERVER_RUNTIME + stacks + r"""

/* Protocole : id|op|nom|[poignée]|args… — `op` vaut call, new ou method. */
static void moodit_traite(const char *moodit_id, const char *moodit_op,
                          const char *moodit_nom) {
""" + "\n".join(branches) + "\n\n" + object_branches + r"""
    moodit_printf("\n%s|err|fonction inconnue\n", moodit_id);
    moodit_fflush(moodit_stdout);
}

int main(void) {
    while (moodit_fgets(moodit_ligne, (int) sizeof moodit_ligne, moodit_stdin)) {
        char *moodit_fin = moodit_cherche(moodit_ligne, '\n');
        if (moodit_fin) { *moodit_fin = 0; }
        moodit_reste = moodit_ligne;
        const char *moodit_i = moodit_jeton();
        const char *moodit_o = moodit_jeton();
        const char *moodit_n = moodit_jeton();
        moodit_traite(moodit_i, moodit_o, moodit_n);
    }
    return 0;
}
""")


# ─────────────────── Rust : bouchon et aiguillage TYPÉS, protocole texte ───────────────────
# Pas de serde dans l'image (aucun réseau à la compilation) : même protocole texte que C.

# `fn` en debut de ligne OU apres `{`, `}`, `;` : `impl R { fn aire(&self) -> i32 { … } }` sur
# une seule ligne est du Rust valide, et l'ancre de debut de ligne seule ne voyait ni cette
# methode ni une seconde fonction sur la meme ligne — « aucune fonction exploitable » sur une
# reponse juste. Le niveau d'accolades (code_depths) ecarte ensuite les fonctions imbriquees.
# Restriction de visibilite BORNEE (`pub(crate)`, `pub(in chemin::du::module)`) et sans fin de
# ligne : sans borne, `;pub(` repete repartait de chaque `;` jusqu'au bout du texte — 8 s par
# cas pour 100 Ko.
# Attributs sur la ligne de la fonction (`#[inline] pub fn`) admis, bornés comme RUST_MAIN.
RUST_FN = re.compile(
    r"(?:^|(?<=[{};]))[ \t]*(?:#\[[^\]\n]{0,200}\][ \t]*){0,8}"
    r"(?:pub(?:\([^)\n]{0,80}\))?\s+)?(?:(?:const|unsafe)\s+){0,2}"
    r"fn\s+(\w+)\s*\(([^()]*)\)\s*->\s*([\w:]+)",
    re.M)
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


# Attributs sur la même ligne (`#[derive(Debug)] struct R`) et visibilité restreinte
# (`pub(crate)`) admis : la structure était ignorée, 0 sur une réponse juste.
RUST_STRUCT = re.compile(
    r"^[ \t]*(?:#\[[^\]\n]*\]\s*)*(?:pub(?:\([^)\n]{0,80}\))?\s+)?struct\s+(\w+)", re.M)
# `impl Type {` et `impl Trait for Type {` (génériques tolérés) : les méthodes d'un trait
# implémenté s'appellent sur l'objet comme les autres. Groupe 1 : le trait, groupe 2 : le type.
RUST_IMPL = re.compile(
    r"^[ \t]*impl(?:\s*<[^<>{};]*>)?\s+(?:(\w+)(?:\s*<[^<>{};]*>)?\s+for\s+)?(\w+)\s*\{", re.M)
RUST_TRAIT = re.compile(r"^[ \t]*(?:pub(?:\([^)\n]{0,80}\))?\s+)?trait\s+(\w+)[^{};]*\{", re.M)


def rust_impl_blocks(source):
    """Blocs `impl` et leurs fonctions DIRECTES → [(type, [(nom, params, retour)])], dans l'ordre
    du texte. FONCTION PURE (testee).

    Une fonction imbriquee dans une methode n'est pas une methode du type : elle est ecartee par
    son niveau d'accolades, comme pour les fonctions libres.

    Les profondeurs et les `fn` sont lues UNE fois sur le texte entier, puis chaque bloc prend
    les siennes par dichotomie. Chaque bloc etait auparavant redecoupe et ses profondeurs
    recalculees : des `impl` ouverts sans etre fermes couvrent chacun tout le reste du fichier,
    donc le cout etait quadratique — 20 Ko de `impl A {` prenaient plus d'une minute par cas,
    avant toute compilation et hors de tout delai."""
    src_text = source or ""
    depths, _ = _closings(src_text)
    by_depth = {}        # profondeur -> (positions des noms, correspondances), ordre du texte
    for hit in RUST_FN.finditer(src_text):
        starts, hits = by_depth.setdefault(depths[hit.start(1)], ([], []))
        starts.append(hit.start(1))
        hits.append(hit)
    def direct_functions(begin):
        finish = block_end(src_text, begin)
        # A la profondeur du corps, entre l'accolade et sa fermeture : exactement les fonctions
        # directes de CE bloc (en sortir puis y revenir demanderait de le fermer).
        starts, hits = by_depth.get(depths[begin] + 1, ((), ()))
        low = bisect.bisect_right(starts, begin)
        high = bisect.bisect_left(starts, finish)
        return [h for h in hits[low:high] if h.end() <= finish]

    # Méthodes PAR DÉFAUT d'un trait (celles qui ont un corps) : un `impl Trait for Type` qui ne
    # les redéfinit pas les offre quand même sur l'objet.
    defaults = {}
    for trait in RUST_TRAIT.finditer(src_text):
        with_body = [h for h in direct_functions(trait.end() - 1)
                     if src_text[h.end():].lstrip().startswith("{")]
        defaults[trait.group(1)] = [(h.group(1), h.group(2), h.group(3)) for h in with_body]
    blocks = []
    for impl in RUST_IMPL.finditer(src_text):
        functions = [(h.group(1), h.group(2), h.group(3)) for h in direct_functions(impl.end() - 1)]
        declared = {f[0] for f in functions}
        functions += [f for f in defaults.get(impl.group(1), []) if f[0] not in declared]
        blocks.append((impl.group(2), functions))
    return blocks


def rust_implemented_traits(source):
    """Traits de PREMIER NIVEAU du code soumis implémentés par un de ses types. PURE (testée).

    Le serveur vit dans un module à part : une méthode de trait ne s'y appelle que si le trait est
    en portée. Ils y sont importés en `use crate::Trait as _;` (aucun nom ajouté)."""
    src_text = source or ""
    depths, _ = _closings(src_text)
    top_level = {t.group(1) for t in RUST_TRAIT.finditer(src_text) if depths[t.start(1)] == 0}
    return sorted({impl.group(1) for impl in RUST_IMPL.finditer(src_text)
                   if impl.group(1) in top_level})



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
    for typ, functions in rust_impl_blocks(src_text):
        if typ not in structs:
            continue
        # Plusieurs blocs `impl` pour le meme type se CUMULENT : le constructeur d'un premier
        # bloc etait perdu quand les methodes venaient d'un second.
        ctors, method_list = by_type.setdefault(typ, ([], []))
        for ident, params, ret in functions:
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


RUST_STRUCT_BODY = re.compile(
    r"^[ \t]*(?:#\[[^\]\n]*\]\s*)*(?:pub(?:\([^)\n]{0,80}\))?\s+)?struct\s+(\w+)\s*\{([^{}]*)\}",
    re.M | re.S)
RUST_UNIT_STRUCT = re.compile(
    r"^[ \t]*(?:#\[[^\]\n]*\]\s*)*(?:pub(?:\([^)\n]{0,80}\))?\s+)?struct\s+(\w+)\s*;", re.M)


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
        # Structure SANS CHAMP (`struct Calculatrice {}`) : capturable aussi, cf. plus bas.
        if entries is not None:
            field_list[typ] = entries
    # Structure UNITE (`struct Calculatrice;`) : sans elle, un type sans champ ni fonction
    # constructrice n'etait pas proxifie, et la question n'etait pas notable.
    for typ in RUST_UNIT_STRUCT.findall(source or ""):
        field_list.setdefault(typ, [])
    return field_list


def rust_mut_receivers(source):
    """Types dont au moins une méthode prend `&mut self`. FONCTION PURE (testée).

    Pendant de `go_pointer_methods` : une telle méthode peut modifier l'objet, et la
    capture de champs le reconstruit à chaque appel — la modification serait perdue EN SILENCE,
    donc un verdict faux sans diagnostic. Ces types passent par la poignée d'un constructeur."""
    mutants = set()
    for typ, functions in rust_impl_blocks(source):
        for _, params, _ in functions:
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
            # Sans champ : structure UNITE, que le harnais peut écrire `T` comme `T {}` — les
            # deux formes sont valides pour elle, quelle que soit celle de l'étudiant.
            declaration = ("struct %s {\n%s\n}" % (
                typ, "\n".join("    %s: %s," % (n, t) for n, t in field_list[typ]))
                if field_list[typ] else "struct %s;" % typ)
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
                # Locales PRÉFIXÉES : nommées comme les champs, un champ `parts` masquait
                # l'itérateur dont les champs suivants sont lus.
                reads = "\n".join(
                    "        let moodit_c_%s = %s;"
                    % (n, RUST_CONV[t] % 'parts.next().unwrap_or("")')
                    for n, t in field_list[typ])
                literal = ", ".join("%s: moodit_c_%s" % (n, n) for n, _ in field_list[typ])
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
        # `crate::` : l'aiguillage vit dans le module du serveur (cf. rust_server_source).
        stacks.append("    let mut moodit_%s: Vec<crate::%s> = Vec::new();" % (typ.lower(), typ))
        if typ in field_list:
            # Locales PRÉFIXÉES : nommées comme les champs, un champ `id` ou `args` (banal)
            # masquait la locale du serveur du même nom — la réponse partait avec la valeur du
            # champ à la place de l'identifiant de la requête, ou le programme ne compilait pas.
            reads = "\n".join(
                '                let moodit_c_%s = %s;'
                % (n, RUST_CONV[t] % 'args.next().unwrap_or("")')
                for n, t in field_list[typ])
            literal = "crate::%s { %s }" % (typ, ", ".join("%s: moodit_c_%s" % (n, n)
                                                    for n, _ in field_list[typ]))
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
                call_expr = "crate::%s::%s(%s)" % (typ, ident,
                                                   ", ".join("a%d" % i for i in range(len(types))))
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
                call_expr = "crate::%s::%s(%s)" % (typ, ident,
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
    return '''// MODULE A PART pour le runtime : les bouchons portent, a la racine, les noms choisis par
// l'etudiant (fonctions, types). Un module enfant ne voit aucun nom de la racine sans le nommer :
// une `fn Ok`, une `struct Vec` ou une `struct String` soumises n'y prennent la place de rien.
mod moodit_rt {

use std::io::{BufRead as MooditBufRead, Write as MooditWrite};

pub fn moodit_hexe(s: &str) -> String {
    // Chaine → HEXADECIMAL : le fil est a champs separes par « | », une ligne par message.
    let mut sortie = String::from("H");
    for octet in s.as_bytes() {
        sortie.push_str(&format!("{:02x}", octet));
    }
    sortie
}

pub fn moodit_dehexe(v: &str) -> String {
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

pub fn moodit_id() -> String {
    // Identifiant IMPRÉVISIBLE par appel, tiré de /dev/urandom : sans lui, le code noté — dont
    // le stdout EST le canal de réponse — pouvait imprimer la réponse attendue avant la question.
    let mut brut = [0u8; 8];
    use std::io::Read;
    std::fs::File::open("/dev/urandom").unwrap().read_exact(&mut brut).unwrap();
    brut.iter().map(|o| format!("{:02x}", o)).collect()
}

pub fn moodit_appel(id: &str, requete: &str) -> String {
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

}

#[allow(unused_imports)]
use moodit_rt::{moodit_appel, moodit_dehexe, moodit_hexe, moodit_id};
#[allow(unused_imports)]
use ::std::io::Write as MooditWrite;

%s

%s

fn moodit_harnais() -> bool {
%s
}

fn main() {
    let ok = ::std::panic::catch_unwind(moodit_harnais).unwrap_or(false);
    if ok {
        eprintln!();
        eprintln!("%s");
        ::std::io::stderr().flush().unwrap();
        ::std::process::exit(0);
    }
    ::std::process::exit(1);
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
        # `crate::` : le serveur déclare ses propres locales (`id`, `args`, `premier`, `cle`,
        # `a0`…), et en Rust une locale masque une fonction du même nom. Une `fn premier` ou une
        # `fn id` soumise ne compilait plus — « Échec de compilation » sur une réponse juste.
        # Le chemin absolu désigne la fonction du code soumis quelles que soient les locales.
        call_expr = "crate::%s(%s)" % (ident, ", ".join("a%d" % i for i in range(len(types))))
        if ret == "String":
            call_expr = "moodit_hexe(&%s)" % call_expr
        branches.append('        "%s" => {\n%s\n            format!("{}|ok|{}", id, %s)\n        }'
                   % (ident, "\n".join(reads), call_expr))
    return '''%s

// MODULE A PART : un module enfant ne voit AUCUN nom du module parent sans le nommer. Le serveur
// partageait la portee du code soumis, et tout nom soumis pouvait y prendre la place d'un des
// siens : une `const id` ou un `static args` (un motif `let id = …` les designe alors, et ne
// lie plus rien), un `type Result<T> = …` (idiome courant), une `struct Vec`. Ici, le code
// soumis n'est atteint que par un chemin `crate::` explicite.
mod moodit_srv {

// ALIASES : le serveur partage le fichier du code soumis, et un `use std::io::Write;` chez
// l'etudiant (banal pour un flush) levait E0252, nom defini deux fois. Les methodes de trait
// marchent des que le trait est en portee, quel que soit son nom.
use std::io::{BufRead as MooditBufRead, Write as MooditWrite};
%s

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

pub fn moodit_serve() {
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

}

fn main() {
    moodit_srv::moodit_serve();
}
''' % (rust_without_main(student_source),
       "".join("#[allow(unused_imports)]\nuse crate::%s as _;\n" % t
               for t in rust_implemented_traits(student_source)),
       stacks, "\n".join(branches), object_branches)


# `main` nu ou précédé de modificateurs : `pub fn main()` n'était pas renommé, le `fn main()`
# du serveur le doublait (E0428), et une réponse juste était notée 0 avec une erreur qui désigne
# du code généré. Même ancre que RUST_FN — début de ligne OU après `{`, `}`, `;` — et attributs
# admis devant : `fn f() -> i32 { 2 } fn main() {}` sur une ligne et `#[allow(dead_code)] fn
# main() {}` gardaient leur `main`, avec le même doublon. Qualificatifs bornés à trois (il n'en
# existe que trois) : leur `\s+` franchit les fins de ligne, et répétés sans borne ils rendaient
# le motif quadratique sur une source faite de `const` un par ligne. Même raison pour les
# attributs et la restriction de visibilité, bornés en longueur et en nombre : `;#[` répété
# sur une seule ligne relisait la ligne entière depuis chaque `;` (12 s par cas pour 100 Ko).
RUST_MAIN = re.compile(
    r"((?:^|(?<=[{};]))[ \t]*(?:#\[[^\]\n]{0,200}\][ \t]*){0,8}"
    r"(?:pub(?:\s*\([^()\n]{0,80}\))?\s+)?(?:(?:const|async|unsafe)\s+){0,3})fn\s+main\s*\(\s*\)",
    re.M)


def rust_without_main(source):
    """Code étudiant dont le `main` de PREMIER NIVEAU est renommé : le serveur fournit le point
    d'entrée. PURE (testée). Les modificateurs sont conservés.

    Seul le `main` de profondeur 0 double celui du serveur. Celui d'un sous-module, d'un `impl`
    ou d'un trait est un nom que le code soumis appelle (`outils::main()`, `A::main()`, `main()`
    depuis le module) : le renommer sans réécrire ses appels cassait la compilation d'une
    réponse juste. La profondeur vient de code_depths, comme pour rust_signatures."""
    text = source or ""
    depths = code_depths(text)

    def rename(hit):
        if depths[hit.end(1)] != 0:
            return hit.group(0)
        return hit.group(1) + "fn __moodit_student_main()"

    return RUST_MAIN.sub(rename, text)


# ─────────────────── C# : bouchon et aiguillage TYPÉS, protocole texte ───────────────────
# mono autorise l'appel natif (dup2) et la réflexion : c'est précisément pourquoi le noteur doit
# vivre AILLEURS. Ici il n'y a plus rien à détourner dans le processus de l'étudiant.

# Visibilite indifferente, comme en Java : en C# une methode de classe est privee PAR DEFAUT,
# donc exiger `public` refusait l ecriture la plus naturelle d un exercice.
# Memes modificateurs qu en Java, cote C#, y compris les deux formes EN DEUX MOTS
# (`protected internal`, `private protected`) : elles sont couvertes par la repetition.
# Repetition BORNEE a huit modificateurs dans les trois motifs qui s'en servent : `\s+` franchit
# les fins de ligne et l'ancre vaut a chaque debut de ligne, donc sans borne 14 000 lignes
# `static` etaient relues depuis chacune d'elles — une trentaine de secondes par cas.
CS_MODS = (r"(?:public|internal|protected|private|static|new|virtual|override|sealed"
           r"|abstract|extern|unsafe|partial)")
CS_METHOD = re.compile(
    r"(?:^|[{};])[ \t]*(?=(?:" + CS_MODS + r"\s+){0,8}static\s)(?:" + CS_MODS + r"\s+){0,8}"
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
            hits.append((ret, ident, types, trailing_defaults(params)))
    return dedupe_signatures(with_default_arities(hits))


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
             'global::System.Globalization.CultureInfo.InvariantCulture)' % i if t == "double"
        else ' + "|" + global::System.Convert.ToString(a%d, '
             'global::System.Globalization.CultureInfo.InvariantCulture)' % i
        for i, t in enumerate(types))


# `global::System.…` dans tout ce qui est émis DANS une classe-bouchon : ses membres portent les
# noms choisis par l'étudiant, et une méthode `Convert` (exercice de conversion) ou `System`
# y masquait la classe ou l'espace de noms du framework — « le harnais ne compile pas ».
# Gabarits de lecture : `v` est le NOM DE L'ARGUMENT, a remplacer par « (v » seulement — un
# remplacement de « v » nu changeait InvariantCulture en InbrutariantCulture (le harnais ne
# compilait plus des qu'une methode rendait un double).
CS_READ = {"int": "int.Parse(v)", "long": "long.Parse(v)",
              "double": "double.Parse(v, global::System.Globalization.CultureInfo.InvariantCulture)",
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
    # Le RUNTIME vit dans son espace de noms, `using` à l'intérieur (cf. cs_server_source) : les
    # bouchons portent, au niveau global, les noms choisis par l'étudiant. Les `using` du niveau
    # global ne servent qu'au harnais du prof ; le verdict (Main) est rendu par le runtime.
    return '''using System;
using System.IO;
using MooditRpc = MooditRt.MooditRpc;

namespace MooditRt {
using global::System;

public static class MooditRpc {
    static readonly global::System.Security.Cryptography.RandomNumberGenerator ALEA =
        global::System.Security.Cryptography.RandomNumberGenerator.Create();

    // Identifiant IMPRÉVISIBLE par appel : sans lui, le code noté — dont le stdout EST le canal
    // de réponse — pouvait imprimer la réponse attendue avant même la question.
    // Mêmes codecs que le serveur : une chaîne ne voyage qu'en hexadécimal, le fil étant à
    // champs séparés par « | » et à une ligne par message.
    public static string Hexe(string s) {
        // null voyage en JETON « N » (une chaîne, même vide, commence par « H ») : rendu par
        // « H » vide, il arrivait en "" — `== null` noté faux sur une réponse juste.
        if (s == null) { return "N"; }
        byte[] brut = global::System.Text.Encoding.UTF8.GetBytes(s);
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
        return global::System.Text.Encoding.UTF8.GetString(octets);
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

    public static int Verdict(Func<bool> harnais, string nonce) {
        bool ok;
        try {
            ok = harnais();
        } catch (Exception e) {
            // Texte relaye SANS saut de ligne, comme les autres noteurs : il peut porter
            // des octets choisis par l etudiant, et une ligne fabriquee est la matiere
            // premiere d une forge.
            Console.Error.WriteLine("[MOODIT] harnais: "
                + e.Message.Replace((char) 10, ' ').Replace((char) 13, ' '));
            ok = false;
        }
        if (ok) {
            Console.Error.WriteLine();
            Console.Error.WriteLine(nonce);
            Console.Error.Flush();
            return 0;
        }
        return 1;
    }
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
        return MooditRpc.Verdict(Harnais, "%s");
    }
}
''' % (klass, cs_object_stub(klass, ctors, instance), "\n\n".join(stubs),
       "\n".join("        " + l if l.strip() else l
                 for l in (harness_code or "").splitlines()), nonce)


def cs_server_source(classes, namespaces=()):
    """Programme ÉTUDIANT C# : son code (compilé à côté) + aiguillage par réflexion. PURE.

    Les espaces de noms du code soumis sont importés : sans cela, `typeof(Solution)` ne
    trouvait pas une classe écrite dans `namespace Quiz { … }`."""
    # ESPACE DE NOMS À PART, avec ses `using` À L'INTÉRIEUR : à l'intérieur d'un espace de noms,
    # ses propres imports passent AVANT les types de l'espace global. Écrit au niveau global, le
    # serveur voyait une classe soumise `Type`, `Console`, `Convert` ou `Exception` prendre la
    # place de celle de System, et le programme de l'étudiant ne compilait plus. Les classes
    # soumises, elles, sont nommées HORS de cet espace (MooditCibles), là où elles l'emportent.
    return "".join("using %s;\n" % n for n in namespaces) + '''
static class MooditCibles {
    public static readonly global::System.Type PRINCIPALE = typeof(%s);
    public static readonly global::System.Type[] TOUTES = { %s };
}

namespace MooditSrv {
using global::System;
using global::System.Reflection;

public static class MooditServer {
    // Objets construits CHEZ L'ÉTUDIANT : le noteur n'en connaît que la poignée.
    static readonly global::System.Collections.Generic.List<object> OBJETS =
        new global::System.Collections.Generic.List<object>();

    // Chaîne → HEXADÉCIMAL sur le fil : le protocole est à champs séparés par « | » et à une
    // ligne par message, donc un « | » ou un saut de ligne dans la valeur décalait tout l'appel.
    public static string Hexe(string s) {
        // null voyage en JETON « N » (une chaîne, même vide, commence par « H ») : rendu par
        // « H » vide, il arrivait en "" — `== null` noté faux sur une réponse juste.
        if (s == null) { return "N"; }
        byte[] brut = global::System.Text.Encoding.UTF8.GetBytes(s);
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
        return global::System.Text.Encoding.UTF8.GetString(octets);
    }

    static object[] Convertis(ParameterInfo[] attendus, string[] parts, int depart) {
        object[] donnes = new object[attendus.Length];
        int fournis = parts.Length - depart;
        for (int i = 0; i < attendus.Length; i++) {
            // Paramètre optionnel omis par l'appel : sa valeur par défaut, celle de l'étudiant.
            if (i >= fournis) { donnes[i] = attendus[i].DefaultValue; continue; }
            string brut = parts[i + depart];
            Type pt = attendus[i].ParameterType;
            if (pt.IsByRef) { pt = pt.GetElementType(); }   // parametre `in` : int& -> int
            if (pt == typeof(string)) {
                donnes[i] = Dehexe(brut);
                continue;
            }
            donnes[i] = Convert.ChangeType(brut, pt,
                    global::System.Globalization.CultureInfo.InvariantCulture);
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
    // Moins d'arguments que de paramètres : seulement si les paramètres omis sont OPTIONNELS
    // (`int acc = 0`) ; les candidats sont essayés par nombre de paramètres croissant
    // (ParArite), donc une surcharge d'arité exacte passe avant une plus longue à défauts.
    static bool Signe(ParameterInfo[] attendus, string appel, int arite) {
        if (arite > attendus.Length) { return false; }
        for (int i = arite; i < attendus.Length; i++) {
            if (!attendus[i].IsOptional) { return false; }
        }
        int p = appel.IndexOf('(');
        if (p < 0) { return arite == attendus.Length; }
        string[] noms = new string[arite];
        for (int i = 0; i < arite; i++) { noms[i] = NomType(attendus[i].ParameterType); }
        return string.Join(",", noms) == appel.Substring(p + 1, appel.Length - p - 2);
    }

    static T[] ParArite<T>(T[] candidats) where T : MethodBase {
        global::System.Array.Sort(candidats,
                (a, b) => a.GetParameters().Length.CompareTo(b.GetParameters().Length));
        return candidats;
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
                    global::System.Globalization.CultureInfo.InvariantCulture);
        }
        if (v is float) {
            return ((float) v).ToString("G9",
                    global::System.Globalization.CultureInfo.InvariantCulture);
        }
        return Convert.ToString(v, global::System.Globalization.CultureInfo.InvariantCulture);
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
                    Type cible2 = global::MooditCibles.PRINCIPALE;
                    bool construit = false;
                    foreach (var c in ParArite(cible2.GetConstructors(
                            BindingFlags.Public | BindingFlags.NonPublic
                            | BindingFlags.Instance))) {
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
                    foreach (MethodInfo m in ParArite(instance.GetType().GetMethods(
                            BindingFlags.Public | BindingFlags.NonPublic
                            | BindingFlags.Instance))) {
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
                foreach (Type __t in global::MooditCibles.TOUTES) {
                    foreach (MethodInfo m in ParArite(__t.GetMethods(
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))) {
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

}
''' % (classes[0], ", ".join("typeof(" + c + ")" for c in classes))


# Meme relaxation qu en Java, et pour la meme raison : en C# un membre est prive PAR DEFAUT.
# ANCREES EN DEBUT DE LIGNE : sans cela, `public` devenu facultatif, un `new Rectangle(3, 4)`
# au milieu d une expression serait pris pour une declaration de constructeur.
CS_CTOR_TPL = (r"(?:^|[{};])[ \t]*(?:(?:public|internal|protected|private|static|extern)\s+){0,8}"
               r"%s\s*\(([^()]*)\)")
CS_INSTANCE = re.compile(
    r"(?:^|[{};])[ \t]*(?!(?:" + CS_MODS + r"\s+){0,8}static\s)(?:" + CS_MODS + r"\s+){0,8}"
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
    ctor_entries = []
    for params in re.findall(CS_CTOR_TPL % re.escape(klass), source or "", re.M):
        types = param_types_of(params)
        if types is not None:
            ctor_entries.append((None, klass, types, trailing_defaults(params)))
    # Une SEULE fois par liste de types : le gabarit lit aussi le constructeur STATIQUE
    # (`static Compteur()`), qui doublait `public Compteur()` — deux constructeurs sans
    # parametre dans le bouchon, que mcs refusait (CS0111) sur une reponse juste.
    for _r, _n, types in with_default_arities(ctor_entries):
        if types not in ctors:
            ctors.append(types)
    # AUCUN constructeur declare : C# fournit le constructeur par defaut, comme Java.
    # Seulement pour une classe DECLAREE dans le code soumis.
    declares = re.findall(CS_CTOR_TPL % re.escape(klass), source or "", re.M)
    if not declares and re.search(r"\bclass\s+%s\b" % re.escape(klass), source or ""):
        ctors = [[]]
    method_list = [(ret, ident, list(types))
                   for ret, ident, types in _cs_members_with_inherited(source or "").get(klass, [])]
    return ctors, dedupe_signatures(method_list)


# `class Carre : Forme, IComparable` : la PREMIERE base est la classe mère quand c'en est une.
CS_BASE = re.compile(r"\bclass\s+(\w+)\s*(?:<[^<>{};]*>)?\s*:\s*([\w.]+)")


@functools.lru_cache(maxsize=8)
def _cs_members_with_inherited(src_text):
    """Comme _cs_instance_members, plus les méthodes HÉRITÉES d'une classe du même texte.
    Mémoïsé ; ne pas modifier le résultat.

    Le bouchon ne portait que les méthodes déclarées : `new Carre(3).Aire()` avec un `Aire()`
    hérité de `Forme` ne compilait pas (CS1061), et l'étudiant qui hérite recevait 0. Le serveur
    les trouve déjà (GetMethods sans DeclaredOnly)."""
    own = _cs_instance_members(src_text)
    classes = set(CS_CLASS.findall(src_text))
    parents = {}
    for child, base in CS_BASE.findall(src_text):
        base = base.split(".")[-1]
        if base in classes and child not in parents:
            parents[child] = base
    apis = {name: ((), methods) for name, methods in own.items()}
    for name in classes:
        apis.setdefault(name, ((), []))
    merged = inherit_instance_methods(apis, parents)
    return {name: methods for name, methods in merged.items() if methods}


CS_CLASS = re.compile(r"\bclass\s+(\w+)")


@functools.lru_cache(maxsize=8)
def _cs_instance_members(src_text):
    """Methodes d'instance de CHAQUE classe du texte → {classe: [(retour, nom, [types])]}.
    Memoise (le meme texte est relu a chaque cas) ; ne pas modifier le resultat.

    Membre DIRECT de sa classe seulement : une autre classe du fichier (Carre a cote de
    Rectangle) ou une classe imbriquee donnaient des bouchons en double, que mcs refusait
    (CS0111) — une reponse juste notee 0.

    En UNE passe : chaque methode est lue une fois, puis rattachee a la classe dont le corps
    la contient, par l'accolade ouvrante de son bloc (dichotomie sur les accolades de sa
    profondeur). Relire le corps de chaque classe coutait le produit des deux : 6 000 classes
    vides prenaient 50 s par cas, et des classes homonymes imbriquees autant, dans le
    superviseur et hors de tout delai."""
    depths = _closings(src_text)[0]
    # Accolade ouvrante du corps de chaque classe → son nom. Prochaine accolade et prochain
    # point-virgule sont gardes d'un en-tete au suivant, au lieu d'etre recherches a chacun.
    owner = {}
    begin = semicolon = -1
    for header in CS_CLASS.finditer(src_text):
        if begin < header.end():
            begin = src_text.find("{", header.end())
            if begin < 0:
                break            # plus aucune accolade : aucune des suivantes n'a de corps
        if semicolon < header.end():
            semicolon = src_text.find(";", header.end())
            if semicolon < 0:
                semicolon = len(src_text)
        # `class Rect;` (declaration anticipee) : l'accolade trouvee appartient a la suite.
        if semicolon > begin:
            owner[begin] = header.group(1)
    members = {}
    if not owner:
        return members
    openings = {}
    for i, c in enumerate(src_text):
        if c == "{":
            openings.setdefault(depths[i], []).append(i)
    for m in CS_INSTANCE.finditer(src_text):
        at_level = openings.get(depths[m.start(2)] - 1, [])
        k = bisect.bisect_left(at_level, m.start(2))
        klass = owner.get(at_level[k - 1]) if k else None
        if klass is None or m.group(2) == "Main":
            continue
        types = _cs_param_types(m.group(3))
        if types is not None:
            members.setdefault(klass, []).append(
                (m.group(1), m.group(2), types, trailing_defaults(m.group(3))))
    return {klass: with_default_arities(found) for klass, found in members.items()}


def _digit_separator(src_text, i, token_start):
    """L'apostrophe en `i` est-elle un séparateur de chiffres (`1'000`, `0xFF'FF`) ? PURE.

    Oui si elle suit un jeton NUMÉRIQUE (qui commence par un chiffre) et précède un chiffre
    hexadécimal. Les préfixes de caractère (`L'a'`, `u'a'`, `u8'a'`) commencent par une lettre,
    et `x = 'a'` n'a pas de jeton collé devant : ils restent des littéraux.

    `token_start` est le début du jeton collé devant l'apostrophe (None s'il n'y en a pas),
    tenu à jour par le balayage de blank_code. Le retrouver en remontant le texte à chaque
    apostrophe était quadratique : 100 Ko de `1'a'a'a…` prenaient quatre minutes par cas."""
    if i + 1 >= len(src_text) or src_text[i + 1] not in "0123456789abcdefABCDEF":
        return False
    return token_start is not None and src_text[token_start].isdigit()


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
    token_start = None       # début du jeton (lettres, chiffres, `_`, séparateurs) en cours
    while i < n:
        c = src_text[i]
        two_chars = src_text[i:i + 2]
        # Le jeton ne survit qu'aux deux branches qui le prolongent (séparateur, caractère de
        # mot) : toute autre le coupe.
        token, token_start = token_start, None
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
        elif not rust and c == chr(39) and _digit_separator(src_text, i, token):
            # Séparateur de chiffres C++14 (`1'000`) : pas un littéral. Le prendre pour une
            # ouverture blanchissait la suite jusqu'à la prochaine apostrophe, et les fonctions
            # suivantes disparaissaient de l'extraction (« aucune fonction exploitable »).
            token_start = token
            res.append(c)
            i += 1
        elif c == '"' or (not rust and c == chr(39)):
            quote = c
            res.append(" ")
            i += 1
            # Un littéral de caractère ne passe pas la fin de ligne : l'apostrophe d'une
            # directive (`#error l'entrée…`, `#pragma message`) blanchissait sinon tout le
            # fichier jusqu'à l'apostrophe suivante, et les fonctions disparaissaient de
            # l'extraction (« aucune fonction exploitable » sur une réponse juste).
            while i < n and src_text[i] != quote and not (quote == chr(39) and src_text[i] == chr(10)):
                if src_text[i] == chr(92) and i + 1 < n and src_text[i + 1] != chr(10):
                    res.append("  ")
                    i += 2
                else:
                    res.append(src_text[i] if src_text[i] == chr(10) else " ")
                    i += 1
            if i < n and src_text[i] == quote:
                res.append(" ")
                i += 1
        else:
            if c.isalnum() or c == "_":
                token_start = i if token is None else token
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
        # Une directive (`#region Méthodes d'aide`, `#if`, `#pragma`) va jusqu'à la fin de sa
        # ligne et ne porte aucun littéral : son apostrophe ouvrait un littéral de caractère
        # jamais fermé, tout le reste du fichier était blanchi, et une réponse juste rendait
        # « Aucune méthode exploitable ».
        directive = src_text[i] == "#" and not src_text[src_text.rfind(chr(10), 0, i) + 1:i].strip()
        if two_chars == "//" or directive:
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
    return bool(cs_object_classes(source))


# Constructeur de N'IMPORTE quelle classe : le gabarit de cs_object_api, le nom capturé.
CS_CTOR_ANY = re.compile(CS_CTOR_TPL % r"(\w+)", re.M)


def cs_object_classes(source):
    """Classes de premier niveau qui offrent un constructeur ET une méthode d'instance, au sens
    de cs_object_api. FONCTION PURE (testée).

    Sans appeler cs_object_api pour chaque classe, qui relisait tout le texte à chaque fois
    (cf. _cs_instance_members) : les constructeurs sont lus en une passe et rattachés par
    leur nom, les méthodes viennent de la passe mémoïsée."""
    src_text = source or ""
    top_level = cs_top_level_classes(src_text)
    if not top_level:
        return []
    wanted = set(top_level)
    # Aucun constructeur déclaré vaut le constructeur par défaut ; sinon il en faut un aux
    # types transportables.
    declared, usable = set(), set()
    for ident, params in CS_CTOR_ANY.findall(src_text):
        if ident in wanted:
            declared.add(ident)
            if _cs_param_types(params) is not None:
                usable.add(ident)
    members = _cs_members_with_inherited(src_text)
    return [n for n in top_level
            if (n in usable or n not in declared) and members.get(n)]


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
    """preexec_fn du processus NOTEUR des compilés : son propre UID, son propre groupe de
    processus. Victime de l'OOM APRÈS le code soumis (OOM_ADJ_TRUSTED), jamais intuable : le
    -1000 hérité du superviseur aurait bloqué l'OOM du cgroup."""
    mark_oom_victim(OOM_ADJ_TRUSTED)
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
                                       stderr=g_err, preexec_fn=oom_victim_first(demote_grader))
        procs.append(grader_proc)
        student_side = subprocess.Popen(student_cmd, cwd=cwd, env=s_env, stdin=req_r, stdout=rep_w,
                                    stderr=s_err, preexec_fn=oom_victim_first(demote_student))
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
        # Le noteur peut être DÉJÀ lancé quand le lancement de l'étudiant échoue : sans ceci, un
        # harnais qui boucle sans appeler de bouchon restait vivant, non récolté, jusqu'à la fin
        # du conteneur.
        for proc in procs:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                proc.wait(timeout=PUMP_SWEEP_JOIN_S)
            except subprocess.TimeoutExpired:
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
    code, expired = compile_student(["javac", "-encoding", "UTF-8", "-d", student_classes, student_file],
                                    case_dir, student_build_env(build_area), case_dir, [student_file],
                                    os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                                    student_classes)
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
    # Inventaire NON abouti : ce n'est pas le code soumis qui est en cause (JVM froide sur un
    # hôte chargé). Le dire, plutôt que « aucune méthode exploitable », qui accuse la réponse.
    if expired:
        return None, ("L'inventaire des méthodes de la classe " + klass + " n'a pas abouti en "
                      + str(LIST_TIMEOUT_S) + " s (machine de correction chargée) : le code "
                      "soumis n'est pas en cause.")
    # Plafond LARGE : une signature par ligne, et la troncature « tête + queue » de read_capped
    # retirait celles du milieu dès 64 Kio — méthodes absentes du bouchon, harnais qui ne
    # compile plus. La taille reste bornée par les classes que javac vient d'accepter.
    javap = read_capped(os.path.join(case_dir, "javap.out"), JAVAP_CAP)
    method_list = java_signatures(javap)
    # Une déclaration de classe par bloc : on les sépare pour lire l'API objet de chacune.
    obj_list = []
    class_statics = {}
    own_ctors, own_instance = (), ()
    blocks = {}
    apis, parents = {}, {}
    for block in re.split(r"(?=^Compiled from )", javap, flags=re.M):
        interface, defaults = java_interface_defaults(block)
        if interface:
            # Interface du code soumis : ses méthodes `default` comptent comme héritées, et
            # celles des interfaces qu'elle étend aussi (`interface Polygone extends Forme`).
            apis[interface] = ((), defaults)
            parents[interface] = java_interfaces(block)
            continue
        source_name, ctors, instance = java_class_api(block)
        if not source_name:
            continue
        blocks[source_name] = block
        apis[source_name] = (ctors, instance)
        superclass = java_superclass(block)
        parents[source_name] = ([superclass] if superclass else []) + java_interfaces(block)
    # Méthodes héritées d'une autre classe du code soumis : le serveur les trouve en remontant
    # les classes mères (methode()), le bouchon doit donc les déclarer aussi.
    inherited = inherit_instance_methods(apis, parents)
    for source_name, block in blocks.items():
        ctors, instance = apis[source_name][0], inherited[source_name]
        if not (ctors or instance):
            continue
        if source_name == klass:
            # La classe publique peut ÊTRE l'objet à instancier (question POO dont la classe
            # s'appelle Rectangle) : son bouchon porte alors le constructeur et les méthodes.
            own_ctors, own_instance = ctors, instance
        else:
            obj_list.append((source_name, ctors, instance))
            class_statics[source_name] = java_signatures(block)
    if code != 0 or not (method_list or obj_list or (own_ctors and own_instance)):
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
                 java_stub_source(klass, method_list, java_grader_objects(obj_list, harness),
                                  own_ctors, own_instance, class_statics))
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
    # accuser de falsification une soumission dont un vrai cas avait reussi (regle 3 de
    # canary_verdict : il n'accuse plus tant que l'autre canari est confirme).
    grader_dead = grader_killed(code, passed)
    note_grader_output_lost(code, passed)
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
            (["mcs", "-main:MooditSrv.MooditServer", "-out:" + student_bin, student_src, student_copy],
             "code soumis", build_area, student_build_env(build_area), None),
            (["mcs", "-main:MooditGrader", "-out:" + grader_bin, grader_src],
             "harnais", case_dir, env, preexec_compile)):
        outputs = (os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"))
        if label == "code soumis":
            code, expired = compile_student(cmd, cwd_c, env_c, case_dir,
                                            [student_src, student_copy], *outputs, student_bin)
        else:
            code, expired = run_proc(cmd, cwd_c, env_c, COMPILE_TIMEOUT_S, *outputs, preexec_c)
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
             None),
            (grader_src, grader_bin, "harnais", case_dir, env, preexec_compile)):
        cmd = ["rustc", "-O", "--edition", "2021", source, "-o", out_value]
        outputs = (os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"))
        if label == "code soumis":
            code, expired = compile_student(cmd, cwd_c, env_c, case_dir, [source], *outputs,
                                            out_value)
        else:
            code, expired = run_proc(cmd, cwd_c, env_c, COMPILE_TIMEOUT_S, *outputs, preexec_c)
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
    note_grader_output_lost(code, passed)
    return CaseOutcome(passed, detail, ran=True, killed=grader_dead), None


C_CONDITIONAL = re.compile(r"^[ \t]*#[ \t]*(?:if|ifdef|ifndef|elif|else)\b", re.M)
C_LINE_MARKER = re.compile(r'#\s*\d+\s+"((?:[^"\\]|\\.)*)"')
# Le préprocesseur seul est rapide ; une bombe d'inclusions ou de macros, elle, tiendrait la
# compilation réelle jusqu'à son délai : on ne lui en laisse pas autant ici, sans conclure.
C_PREPROCESS_TIMEOUT_S = 10
C_PREPROCESS_CAP = 16 * 1024 * 1024
# Une fois par job : les cas d'un job ont le même code soumis (comme compile_student).
C_PREPROCESSED = {}


def c_student_segment(preprocessed, file_name):
    """Lignes que les marqueurs de `gcc -E` attribuent à `file_name`. FONCTION PURE (testée)."""
    keep, current = [], None
    for line in (preprocessed or "").splitlines():
        marker = C_LINE_MARKER.match(line)
        if marker:
            current = marker.group(1)
        elif current == file_name:
            keep.append(line)
    return chr(10).join(keep)


def c_directives_only_source(student_source, compiler, std, case_dir, ext):
    """Code soumis aux directives TRAITÉES (`gcc -E -fdirectives-only`, segment du fichier soumis
    seulement : branches `#if` inactives écartées, macros NON développées), ou None : aucune
    directive conditionnelle (rien à écarter), ou préprocesseur en échec — la compilation réelle
    dira pourquoi. Mêmes options que la vraie compilation (`-O1 -fno-builtin` définissent
    `__OPTIMIZE__`, `__NO_INLINE__`) ; sous l'UID étudiant, dans son chantier."""
    if not C_CONDITIONAL.search(student_source or ""):
        return None
    key = (compiler, std, student_source)
    if key in C_PREPROCESSED:
        return C_PREPROCESSED[key]
    lock_src_dir(case_dir)
    build_area = student_build_dir(case_dir)
    name = "pp." + ext
    source = os.path.join(build_area, name)
    target = os.path.join(build_area, "pp.i")
    with open(source, "w", encoding="utf-8") as f:
        f.write(student_source)
    set_owner_mode(source, STUDENT_UID, STUDENT_GID, 0o600)
    segment = None
    try:
        code, expired = run_proc([compiler, std, "-O1", "-fno-builtin", "-E", "-fdirectives-only",
                                  name, "-o", "pp.i"], build_area, student_build_env(build_area),
                                 C_PREPROCESS_TIMEOUT_S, os.path.join(case_dir, "pp.out"),
                                 os.path.join(case_dir, "pp.err"), preexec_student_compile)
        if code == 0 and not expired:
            # Sans suivre de lien, fichier ordinaire seulement (chantier de l'UID étudiant).
            fd = os.open(target, os.O_RDONLY | O_NO_LINK)
            with os.fdopen(fd, "rb") as f:
                if stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    data = f.read(C_PREPROCESS_CAP + 1)
                    if len(data) <= C_PREPROCESS_CAP:
                        segment = c_student_segment(data.decode("utf-8", "replace"), name)
    except OSError:
        segment = None
    finally:
        for leftover in (source, target):
            try:
                os.unlink(leftover)
            except OSError:
                pass
    C_PREPROCESSED[key] = segment
    return segment


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
    # Lecture du source APRÈS les directives (branches `#if` écartées, macros intactes) : une
    # fonction, une méthode ou une surcharge sous `#ifdef DEBUG` figurait dans le texte, absente
    # du code compilé — le serveur l'appelait, « implicit declaration », « has no member », 0 sur
    # une réponse juste.
    directives_done = c_directives_only_source(student_source, compiler, std, case_dir, ext)
    extraction = blank_code(directives_done if directives_done is not None else student_source)
    obj_list = cpp_object_api(extraction) if ext == "cpp" else []
    method_list = c_signatures(extraction, cpp=(ext == "cpp"))
    if not (method_list or obj_list):
        return None, ("Aucune fonction exploitable dans le code soumis "
                      "(types acceptés : int, long, double).")
    harness = harness_rpc_body(case_dir) or ""
    # Le noteur ne recoit que les bouchons que le HARNAIS EMPLOIE : un bouchon que le harnais
    # ne nomme pas ne sert a rien, et son #define y detournerait un outil de la bibliotheque.
    # En C, une fonction d'aide `abs` que le harnais n'appelle pas n'est donc plus refusee
    # (0 sur une reponse juste). Le nombre de sondes, lui, est borne par c_probe_plan : des
    # milliers de fonctions soumises tenaient le conteneur jusqu'au mur.
    grader_methods = [m for m in method_list if harness_mentions(harness, m[1])]
    # Refus AVANT toute compilation : une fonction soumise au nom d'une fonction ou d'une macro
    # de la bibliotheque standard fournie au harnais (fabs, sqrt, isnan, abs, true…) prendrait
    # sa place dans le harnais (voir c_grader_source).
    # Seuls les noms que le HARNAIS emploie sont sondes, en C comme en C++. Le C++ les sondait
    # tous tant que le serveur incluait <stdlib.h> apres le code soumis (une `int abs(int)` de
    # liaison C++ y heurtait la declaration de liaison C) ; il n'inclut plus aucun en-tete
    # (C_SERVER_RUNTIME), et une fonction d'aide `abs` ou `index` y est du code ordinaire.
    probed = grader_methods
    # Les noms reserves a l'IMPLEMENTATION (`__x`, `_X`) restent refuses pour TOUTE fonction
    # soumise, harnais ou pas : controle textuel, sans compilation.
    # Même règle pour les CLASSES (C++) : seules celles que le harnais nomme reçoivent un
    # bouchon, et leur nom est sondé avec ceux des fonctions. Un bouchon `class remove` ou
    # `class time` heurtait la fonction du même nom des en-têtes du noteur — « le harnais ne
    # compile pas », sans que le prof ni l'étudiant puissent en deviner la cause.
    grader_objects = [o for o in obj_list if harness_mentions(harness, o[0])]
    reserved = c_implementation_reserved([ident for _, ident, _ in method_list])
    reserved += [n for n in c_reserved_names(
        [ident for _, ident, _ in probed] + [o[0] for o in grader_objects], compiler, std,
        case_dir, env) if n not in reserved]
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
    write_private(grader_src, c_grader_source(grader_methods, harness, TOKENS.get(case_index) or "",
                                          cpp=(ext == "cpp"), obj_list=grader_objects))
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
        cmd = [compiler, std, "-O1", "-fno-builtin", source, "-o", out_value, "-lm"]
        outputs = (os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"))
        if label == "code soumis":
            code, expired = compile_student(cmd, cwd_c, env_c, case_dir, [source], *outputs,
                                            out_value)
        else:
            code, expired = run_proc(cmd, cwd_c, env_c, COMPILE_TIMEOUT_S, *outputs, preexec_c)
        if expired or code != 0:
            detail = read_capped(os.path.join(case_dir, "cc.err"))[:1500]
            if label == "harnais":
                return None, harness_build_failure(expired, code, "contre le code soumis", detail)
            return None, "Échec de compilation :\n" + detail
        if label == "code soumis":
            # Symboles de la libc redéfinis par le code soumis, lus sur le BINAIRE (cf.
            # c_binary_linked_symbols). nm tourne sous l'UID étudiant, comme la compilation.
            nm_out = os.path.join(case_dir, "nm.out")
            code, expired = run_proc(["nm", "--defined-only", out_value], cwd_c, env_c,
                                     COMPILE_TIMEOUT_S, nm_out, os.path.join(case_dir, "nm.err"),
                                     preexec_c)
            linked = c_binary_linked_symbols(code, expired, nm_out)
            if linked:
                return None, reserved_name_message(
                    linked, "la bibliothèque standard, dont le programme de correction se sert")

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
    # Refus SEULEMENT si le harnais emploie le nom (ou si le serveur genere en a besoin) : une
    # fonction d'aide `max` que le harnais ne nomme pas ne detourne rien, et la refuser mettait
    # 0 a une reponse juste. Son bouchon est simplement omis du noteur (go_hidden_names).
    submitted = ([ident for _, ident, _ in method_list]
                 + [name for type_name, ctors, _ in obj_list
                    for name in [type_name] + [c[0] for c in ctors]])
    reserved, packages, hidden = go_hidden_names(submitted, harness)
    # Toute déclaration de paquet compte pour le serveur, pas seulement celles qui reçoivent un
    # bouchon : variables, constantes, types sans méthode, fonctions non transportables.
    reserved = list(dict.fromkeys(reserved + go_server_hidden(extraction)))
    if reserved:
        return None, reserved_name_message(reserved, "le langage Go (identifiant prédéclaré)")
    if packages:
        return None, reserved_name_message(packages, "un paquet Go importé pour le harnais")
    grader_methods, grader_objects = go_without_hidden(method_list, obj_list, hidden)

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
                 go_grader_source(grader_methods, harness, TOKENS.get(case_index) or "",
                                  grader_objects, field_list, go_pointer_methods(extraction)))
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
            (student_mod, student_bin, "code soumis", student_build_env(build_area), None),
            (grader_src_dir, grader_bin, "harnais", env, preexec_compile)):
        cmd = ["go", "build", "-o", out_value, "."]
        outputs = (os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"))
        if label == "code soumis":
            code, expired = compile_student(
                cmd, directory, env_c, case_dir,
                [os.path.join(student_mod, name) for name in ("go.mod", "solution.go", "serveur.go")],
                *outputs, out_value)
        else:
            code, expired = run_proc(cmd, directory, env_c, COMPILE_TIMEOUT_S, *outputs, preexec_c)
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
    for root, _, files in walk_tree(os.path.join(case_dir, "src")):
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
        # Et DIRE la cause : le détail serait resté « Le harnais a renvoyé faux » (ou l'équivalent
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
        # -I (mode isolé) : le dossier du script n'entre PAS dans sys.path, pas plus que le
        # site utilisateur ($HOME est inscriptible) ni PYTHONPATH. Sans lui, sys.path[0] valait
        # /box/src, que le serveur étudiant peut écrire : un `import numpy` du harnais (ou tout
        # module pas encore chargé, y compris ceux que numpy importe à son tour) était résolu
        # d'abord dans ce dossier, et un fichier `pickle.py` déposé par le code soumis
        # s'exécutait DANS le noteur — où il lisait le nonce. Le noteur n'importe rien de son
        # dossier ; student_server.py est lancé à part (sys.executable), sans cette option.
        return None, ["python3", "-I", entry]
    if runtime == "javascript":
        # --disable-sigusr1 : un SIGUSR1 n'ouvre pas l'inspecteur (défense en profondeur : les
        # noteurs Node l'ignorent déjà). Sous le même UID, le code soumis pouvait l'envoyer au
        # noteur et lire le nonce par l'inspecteur.
        return None, ["node", "--disable-sigusr1", entry]
    if runtime == "typescript":
        # Transpile tous les .ts côte à côte (le grader spawn `node student_server` → .js résolu).
        # --noCheck : transpilation seule, typage permissif à l'exécution (parité avec l'ancien
        # runtime Piston ; les erreurs de SYNTAXE restent des erreurs de compilation).
        return (["sh", "-c", "tsc --noCheck --target es2020 --module commonjs --esModuleInterop "
                             "--skipLibCheck *.ts"],
                ["node", "--disable-sigusr1", entry[:-3] + ".js" if entry.endswith(".ts") else entry])
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
    for root, dirs, files in walk_tree(BOX):
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
    if not student_filter_available():
        print(json.dumps({"v": 1, "error": STUDENT_FILTER_UNAVAILABLE}))
        return
    announce_submitted_code_stage()
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
        # Même preexec que la compilation du code soumis en notation : UID étudiant, SANS les
        # rlimits du run. RLIMIT_NPROC (128, threads compris) s'appliquait à `go build`, qui
        # lance un fil par cœur et par paquet : sur un hôte à beaucoup de cœurs, un code correct
        # pouvait échouer en EAGAIN à la compilation.
        code, timed_out = run_proc(compile_cmd, src, env, EXEC_COMPILE_TIMEOUT_S,
                                   os.path.join(outputs, "cc.out"), os.path.join(outputs, "cc.err"),
                                   preexec_student_compile)
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
    remove_tree(STAGING)
    return True


def after_case_cleanup(language, case):
    """Isolation inter-cas : un processus étudiant qui a fait fork + setsid a quitté le groupe tué
    au timeout — il survivrait au cas et pourrait peser sur (voire tracer, même UID) les cas
    suivants. Balayage de TOUT processus UID étudiant, puis /tmp et /dev/shm vidés."""
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
    remove_tree(os.path.join(BOX, "cases", str(case["index"])))


def main():
    # AVANT tout chown/setuid : l'UID étudiant de ce conteneur est tiré au sort.
    randomize_student_uid()
    if not wait_for_files():
        print(json.dumps({"v": 1, "error": "fichiers du job non reçus"}))
        return
    with open(os.path.join(BOX, "job.json"), "r", encoding="utf-8") as f:
        job = json.load(f)
    # job.json decrit TOUS les cas (caches et canaris compris ; le code des harnais, lui, est dans
    # l'arbre des cas) : il est DEPLACE ici par
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
    if not student_filter_available():
        print(json.dumps({"v": 1, "error": STUDENT_FILTER_UNAVAILABLE}))
        return
    announce_submitted_code_stage()
    if language == "go":
        # Dossiers de build ETUDIANTS, Go seulement : le compilateur du code soumis tourne sous
        # son UID. Créés pour tous les langages, ils étaient un point d'écriture de l'étudiant
        # jamais vidé, hors de cases/.
        reset_go_student_dirs()
    timeout_s = max(1, min(MAX_RUN_TIMEOUT_S,
                           int(job.get("timeout_ms") or DEFAULT_RUN_TIMEOUT_S * 1000) // 1000))
    if language in ("java", "csharp"):
        # Plancher VM, symétrique du mode exec : la JVM (ou mono)
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
        # Nettoyage d'après-cas (after_case_cleanup) protégé : une exception ici, hors du try du cas, tuait le
        # superviseur sans JSON (502 « sans verdict », réessai offert au code soumis).
        try:
            after_case_cleanup(language, case)
        except Exception as e:
            log("superviseur: nettoyage après le cas %s : %r" % (case["index"], e))
            event("erreur_superviseur", case=case["index"], detail=repr(e))

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
