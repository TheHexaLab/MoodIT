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
  - DÉTECTION  : inutile sur ce chemin — le harnais et le nonce n'entrent jamais dans un
    est disponible ; toute ouverture d'une source verrouillée devient un événement
    processus ou un fichier que le code soumis puisse atteindre : il n'y a rien à surveiller.

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


JETON_MODULE = "zzzz_moodit_jeton"


RUST_TEST_PATH = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$")


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


def lock_sources(src_dir):
    """Sources (harnais compris) illisibles par l'étudiant — root, 700."""
    for root, dirs, files in os.walk(src_dir):
        for name in dirs + files:
            path = os.path.join(root, name)
            os.chown(path, 0, 0)
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


def run_c(case_dir, env, timeout_s, case_index):
    """Notation d'un cas C : harnais booleen, deux programmes, deux UID."""
    return run_c_rpc(case_dir, env, timeout_s, case_index, "gcc", "-std=c17", "c")


def run_cpp(case_dir, env, timeout_s, case_index):
    """Notation d'un cas C++ : harnais booleen, deux programmes, deux UID."""
    return run_c_rpc(case_dir, env, timeout_s, case_index, "g++", "-std=c++20", "cpp")


def harness_rpc_body(case_dir):
    """Corps du harnais BOOLÉEN d'un cas, ou None si aucun fichier marqué n'est présent.

    Le marqueur est posé par HarnessProjects : un harnais qui renvoie un booléen prend le chemin
    NON FALSIFIABLE (deux processus, deux UID), un vrai test de framework garde l'ancien."""
    src = os.path.join(case_dir, "src")
    if not os.path.isdir(src):
        return None
    for nom in sorted(os.listdir(src)):
        chemin = os.path.join(src, nom)
        if not os.path.isfile(chemin):
            continue
        try:
            with open(chemin, "r", encoding="utf-8", errors="replace") as f:
                contenu = f.read()
        except OSError:
            continue
        if "__MOODIT_HARNAIS__" in contenu:
            return contenu.split("__MOODIT_HARNAIS__", 1)[1].lstrip("\n")
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
JAVAP_SIGNATURE = re.compile(
    r"^\s+(?:public\s+|protected\s+|private\s+)?static\s+([\w.$\[\]]+)\s+(\w+)\(([^)]*)\);",
    re.M)

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


JAVAP_CLASS = re.compile(r"^(?:public\s+)?(?:final\s+|abstract\s+)?class\s+([\w.$]+)", re.M)
JAVAP_CTOR = re.compile(r"^\s+public\s+([\w.$]+)\(([^)]*)\);", re.M)
JAVAP_METHOD = re.compile(r"^\s+public\s+([\w.$\[\]]+)\s+(\w+)\(([^)]*)\);", re.M)


def java_class_api(javap_output):
    """API OBJET d'une classe compilée → (nom source, [constructeurs], [méthodes d'instance]).

    FONCTION PURE (testée). Permet de proxifier `new Rectangle(3, 4).aire()` : le harnais du prof
    garde l'écriture naturelle, mais l'objet VIT dans le processus de l'étudiant — le noteur n'en
    manipule qu'une POIGNÉE. Les types non marshalables écartent la signature concernée, jamais la
    classe entière.

    `nom source` : les classes imbriquées sont compilées en `Outer$Inner` ; le harnais les écrit
    `Outer.Inner`, et c'est cette forme qu'on rend."""
    classe = JAVAP_CLASS.search(javap_output or "")
    if not classe:
        return None, [], []
    binaire = classe.group(1)
    simple = binaire.split("$")[-1]
    ctors = []
    for nom, args in JAVAP_CTOR.findall(javap_output):
        if nom.split("$")[-1] != simple and nom != binaire:
            continue
        types = [a.strip() for a in args.split(",") if a.strip()]
        if all(t in JSON_TYPES for t in types):
            ctors.append(types)
    methodes = []
    for retour, nom, args in JAVAP_METHOD.findall(javap_output):
        if nom == "main" or retour not in JSON_TYPES:
            continue
        types = [a.strip() for a in args.split(",") if a.strip()]
        if all(t in JSON_TYPES for t in types):
            methodes.append((retour, nom, types))
    # Les méthodes STATIQUES sont déjà proxifiées par java_signatures : on ne garde ici que
    # l'instance, pour ne pas générer deux fois le même bouchon.
    statiques = {(r, n, tuple(t)) for r, n, t in java_signatures(javap_output)}
    methodes = [m for m in methodes if (m[0], m[1], tuple(m[2])) not in statiques]
    return binaire.replace("$", "."), ctors, methodes


def java_object_stub(nom_source, ctors, methodes):
    """Bouchon d'une classe OBJET : constructeur → poignée, méthodes → appel sur la poignée.

    FONCTION PURE (testée). Une classe imbriquée (`Outer.Inner`) est rendue dans sa coquille, pour
    que le harnais puisse l'écrire exactement comme l'étudiant l'a déclarée."""
    simple = nom_source.split(".")[-1]
    corps = ["    public static final class " + simple + " {",
             "        private final int __h;"]
    for types in ctors or [[]]:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        corps += ["        public %s(%s) {" % (simple, params),
                  "            this.__h = MooditRpc.nouvelle(\"%s\", new Object[]{%s});"
                  % (nom_source, args),
                  "        }"]
    for retour, nom, types in methodes:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        corps += ["        public %s %s(%s) {" % (retour, nom, params),
                  "            return MooditRpc.%s(__h, \"%s\", new Object[]{%s});"
                  % ("m" + JSON_TYPES[retour].lower(), nom, args),
                  "        }"]
    corps.append("    }")
    return "\n".join(corps)


def java_signatures(javap_output):
    """Méthodes STATIQUES du code étudiant → [(retour, nom, [types])], visibilité indifférente.

    FONCTION PURE (testée). `main` est écartée (point d'entrée, pas une API notée), ainsi que
    toute signature dont un type n'est pas marshalable."""
    trouvees = []
    for retour, nom, args in JAVAP_SIGNATURE.findall(javap_output or ""):
        if nom == "main":
            continue
        types = [a.strip() for a in args.split(",") if a.strip()]
        if retour not in JSON_TYPES or any(t not in JSON_TYPES for t in types):
            continue
        trouvees.append((retour, nom, types))
    return trouvees


def java_stub_source(class_name, methods, objects=(), self_ctors=(), self_instance=()):
    """Classe-BOUCHON compilée avec le harnais : mêmes signatures, corps = appel RPC.

    FONCTION PURE (testée). Le harnais du prof compile contre elle sans rien savoir ; aucune
    ligne de code étudiant n'entre dans ce programme. `objects` apporte les classes IMBRIQUÉES
    proxifiées par poignée, pour que `new Solution.Rectangle(3, 4).aire()` s'écrive naturellement
    alors que l'objet vit, lui, dans le processus de l'étudiant."""
    lignes = ["public final class " + class_name + " {"]
    if self_ctors and self_instance:
        # La classe de premier niveau EST l'objet : c'est le cas d'une question POO dont la
        # classe publique est `Rectangle`, et le harnais écrit `new Rectangle(3, 4).aire()`.
        lignes.append("    private final int __h;")
        for types in self_ctors or [[]]:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            lignes += ["    public %s(%s) {" % (class_name, params),
                       "        this.__h = MooditRpc.nouvelle(\"%s\", new Object[]{%s});"
                       % (class_name, args),
                       "    }"]
        for retour, nom, types in self_instance:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            lignes += ["    public %s %s(%s) {" % (retour, nom, params),
                       "        return MooditRpc.%s(__h, \"%s\", new Object[]{%s});"
                       % ("m" + JSON_TYPES[retour].lower(), nom, args),
                       "    }"]
    else:
        lignes.append("    private " + class_name + "() {}")
    for nom_source, ctors, instance in objects:
        lignes.append(java_object_stub(nom_source, ctors, instance))
    for retour, nom, types in methods:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        lignes += ["    public static %s %s(%s) {" % (retour, nom, params),
                   "        return MooditRpc.%s(\"%s\", new Object[]{%s});"
                   % (JAVA_RPC_FN[JSON_TYPES[retour]], nom, args),
                   "    }"]
    lignes.append("}")
    return "\n".join(lignes) + "\n"


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
    static String mstring(int h, String n, Object[] a) { return dechaine(valeur(appelMethode(h, n, a))); }

    static int integer(String nom, Object[] args) { return Integer.parseInt(valeur(echange(nom, args))); }
    static long long_(String nom, Object[] args) { return Long.parseLong(valeur(echange(nom, args))); }
    static double double_(String nom, Object[] args) { return Double.parseDouble(valeur(echange(nom, args))); }
    static boolean boolean_(String nom, Object[] args) { return Boolean.parseBoolean(valeur(echange(nom, args))); }
    static String string(String nom, Object[] args) { return dechaine(valeur(echange(nom, args))); }

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
            System.err.println("[MOODIT] harnais: " + t);
        }
        if (ok) {
            // Nonce sur STDERR : stdout est le tube vers l'étudiant, et l'étudiant ne tient
            // aucun descripteur sur ce flux-ci.
            System.err.print("__NONCE__");
            System.err.flush();
        }
        System.exit(ok ? 0 : 1);
    }
}
""".replace("__CORPS__", indent_java(harness_code)).replace("__NONCE__", nonce)


def indent_java(corps):
    """Corps du harnais indenté dans la méthode. FONCTION PURE (testée)."""
    return "\n".join("        " + l if l.strip() else l for l in (corps or "").splitlines())


def java_server_source(class_name):
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
        String nom = entre(ligne, "\\"name\\":\\"", "\\"");
        String brut = entre(ligne, "\\"args\\":[", "]");
        Object[] args = decoupe(brut);
        Method cible = null;
        for (Method m : Class.forName("__CLASSE__").getDeclaredMethods()) {
            if (m.getName().equals(nom) && m.getParameterCount() == args.length) { cible = m; break; }
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
        String classe = entre(ligne, "\\"class\\":\\"", "\\"").replace('.', '$');
        Object[] args = decoupe(entre(ligne, "\\"args\\":[", "]"));
        Class<?> cible = Class.forName(classe);
        for (java.lang.reflect.Constructor<?> c : cible.getDeclaredConstructors()) {
            if (c.getParameterCount() != args.length) { continue; }
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
        String nom = entre(ligne, "\\"name\\":\\"", "\\"");
        int handle = Integer.parseInt(entre(ligne + ",", "\\"handle\\":", ",").trim());
        Object[] args = decoupe(entre(ligne, "\\"args\\":[", "]"));
        Object instance = OBJETS.get(handle);
        for (Method m : instance.getClass().getDeclaredMethods()) {
            if (!m.getName().equals(nom) || m.getParameterCount() != args.length) { continue; }
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

    private static Object convertit(Class<?> type, String brut) {
        String v = brut.trim();
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
""".replace("__CLASSE__", class_name)


# ─────────────────────────── Go : bouchon et aiguillage TYPÉS ───────────────────────────
# Go n'a pas de réflexion utilisable ici : les deux côtés sont générés à partir des signatures
# lues dans la source de l'étudiant. Le code noté part dans un BINAIRE séparé (le harnais n'est
# ni compilé avec lui, ni présent dans son système de fichiers).

GO_FUNC = re.compile(r"^func\s+(\w+)\s*\(([^)]*)\)\s*([\w\[\]\*\.]+)?\s*\{", re.M)
GO_TYPES = {"int": "int", "int64": "int64", "float64": "float64", "bool": "bool",
            "string": "string"}


def go_signatures(source):
    """Fonctions de premier niveau du code étudiant → [(retour, nom, [types])].

    FONCTION PURE (testée). On accepte `func f(a int, b int) int` et la forme groupée
    `func f(a, b int) int`. `main` est écartée, ainsi que toute signature dont un type n'est pas
    marshalable : le harnais qui l'appellerait ne compilerait pas — message au prof, jamais un
    faux verdict."""
    trouvees = []
    for nom, params, retour in GO_FUNC.findall(source or ""):
        if nom == "main" or (retour or "") not in GO_TYPES:
            continue
        types = []
        valide = True
        for groupe in [p.strip() for p in params.split(",") if p.strip()]:
            morceaux = groupe.split()
            if len(morceaux) == 2:
                types.append(morceaux[1])
            elif len(morceaux) == 1:
                types.append(None)          # type porté par le groupe suivant (a, b int)
            else:
                valide = False
        # Propagation à rebours des types groupés : (a, b int) → [int, int]
        dernier = None
        for i in range(len(types) - 1, -1, -1):
            if types[i] is None:
                types[i] = dernier
            else:
                dernier = types[i]
        if not valide or any(t not in GO_TYPES for t in types):
            continue
        trouvees.append((retour, nom, types))
    return trouvees


GO_STRUCT = re.compile(r"^type\s+(\w+)\s+struct\b", re.M)
GO_METHOD = re.compile(
    r"^func\s+\(\s*\w+\s+(\*?)(\w+)\s*\)\s*(\w+)\s*\(([^)]*)\)\s*([\w\[\]\*\.]+)?\s*\{", re.M)


def go_object_api(source):
    """API OBJET Go → [(type, [(nom de constructeur, [types])], [(retour, méthode, [types])])].

    FONCTION PURE (testée). Go n'a pas de constructeur, et DEUX formes sont proxifiées, parce que
    les deux sont l'idiome : la fonction qui renvoie la structure (`NewRectangle(3, 4)`), et le
    littéral à champs nommés (`Rectangle{largeur: 3, hauteur: 4}`), pris en charge par capture de
    champs (cf. go_object_stub). Un type sans méthode marshalable n'est pas proxifié : le harnais
    qui l'appelle ne compilera pas — message au prof, jamais un faux verdict."""
    champs = go_capture_fields(source)
    structs = set(GO_STRUCT.findall(source or ""))
    if not structs:
        return []
    par_type = {s: ([], []) for s in structs}
    for nom, params, retour in GO_FUNC.findall(source or ""):
        # `func NewRectangle(…) *Rectangle` est la forme la plus répandue : sans retirer l'étoile,
        # ce constructeur n'était pas reconnu et la question n'était pas proxifiée.
        if (retour or "").lstrip("*") not in structs or nom == "main":
            continue
        types = _go_param_types(params)
        if types is not None:
            cible = (retour or "").lstrip("*")
            par_type[cible][0].append((nom, types, (retour or "").startswith("*")))
    for _, recepteur, nom, params, retour in GO_METHOD.findall(source or ""):
        if recepteur not in structs:
            continue
        if (retour or "") not in GO_TYPES:
            continue
        types = _go_param_types(params)
        if types is not None:
            par_type[recepteur][1].append((retour, nom, types))
    return [(t, c, m) for t, (c, m) in sorted(par_type.items()) if m and (c or t in champs)]


def _go_param_types(params):
    """Types des paramètres d'une signature Go, ou None si l'un n'est pas marshalable. PURE."""
    types = []
    for groupe in [p.strip() for p in params.split(",") if p.strip()]:
        morceaux = groupe.split()
        if len(morceaux) == 2:
            types.append(morceaux[1])
        elif len(morceaux) == 1:
            types.append(None)
        else:
            return None
    dernier = None
    for i in range(len(types) - 1, -1, -1):
        if types[i] is None:
            types[i] = dernier
        else:
            dernier = types[i]
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
    champs = {}
    for typ, corps in GO_STRUCT_BODY.findall(source or ""):
        liste = []
        for ligne in corps.splitlines():
            nue = ligne.split("//")[0].strip()
            if not nue:
                continue
            morceaux = nue.replace(",", " ").split()
            if len(morceaux) < 2 or morceaux[-1] not in GO_TYPES:
                liste = None
                break
            for nom in morceaux[:-1]:
                liste.append((nom, morceaux[-1]))
        if liste:
            champs[typ] = liste
    return champs


def go_pointer_receivers(source):
    """Types dont au moins une méthode a un RÉCEPTEUR POINTEUR. FONCTION PURE (testée).

    Une telle méthode peut modifier l'objet. La capture de champs reconstruisant l'objet à chaque
    appel, la modification serait perdue EN SILENCE (verdict faux sans diagnostic) : ces types
    passent donc par la poignée d'un constructeur, ou ne sont pas proxifiés du tout."""
    return {recepteur for etoile, recepteur, _, _, _ in GO_METHOD.findall(source or "") if etoile}


def go_capture_fields(source):
    """Champs CAPTURABLES : ceux des structures sans méthode à récepteur pointeur. PURE (testée).

    Décision prise ICI et nulle part ailleurs : bouchon, aiguillage et lecture d'API doivent
    s'accorder, sinon un type est miroité d'un côté et traité par poignée de l'autre."""
    mutants = go_pointer_receivers(source)
    return {t: f for t, f in go_struct_fields(source).items() if t not in mutants}


def go_object_stub(objets, champs=None):
    """Bouchons OBJET Go : littéral à champs capturés ou poignée, et méthodes relayées.

    FONCTION PURE (testée). Quand tous les champs sont marshalables, le bouchon les MIROITE :
    le harnais écrit son littéral habituel, et la méthode construit l'objet CHEZ l'étudiant au
    moment de l'appel. Une fonction-constructeur reste proxifiée dans ce mode — elle s'exécute
    chez l'étudiant et le bouchon RELIT les champs du résultat, ce qui garde la valeur simple et
    autorise aussi bien `NewRectangle(3, 4)` que le littéral. Sinon : poignée du constructeur."""
    champs = champs or {}
    morceaux = []
    for typ, ctors, methodes in objets:
        if typ in champs:
            morceaux.append("type %s struct {\n%s\n}"
                            % (typ, "\n".join("    %s %s" % (n, t) for n, t in champs[typ])))
            for nom, types, pointeur in ctors:
                params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
                args = ", ".join("a%d" % i for i in range(len(types)))
                lectures = ", ".join(
                    "%s: %s" % (n, GO_CONV[t] % ("mooditIndex(champs, %d)" % i))
                    for i, (n, t) in enumerate(champs[typ]))
                # Le constructeur garde SA signature ici aussi : la branche à poignée le faisait
                # déjà, pas celle-ci, et un harnais qui rangeait le résultat dans un *T (ou le
                # comparait à nil) ne compilait que d'un côté.
                morceaux.append('''func %s(%s) %s%s {
    champs := mooditChamps("%s", []interface{}{%s})
    return %s%s{%s}
}''' % (nom, params, "*" if pointeur else "", typ, nom, args,
        "&" if pointeur else "", typ, lectures))
            valeurs = ", ".join("o.%s" % n for n, _ in champs[typ])
            for retour, nom, types in methodes:
                params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
                args = ", ".join("a%d" % i for i in range(len(types)))
                conv = GO_CONV[retour] % (
                    'mooditMethode(int(mooditEntier(mooditNouvelle("%s", []interface{}{%s}))), '
                    '"%s.%s", []interface{}{%s})' % (typ, valeurs, typ, nom, args))
                morceaux.append('''func (o %s) %s(%s) %s {
    return %s
}''' % (typ, nom, params, retour, conv))
            continue
        morceaux.append("type %s struct {\n    __h int\n}" % typ)
        for nom, types, pointeur in ctors:
            params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            # Le constructeur garde SA signature : `*Rectangle` s'il rend un pointeur, pour que
            # le harnais du prof s'écrive exactement comme avec le code de l'étudiant.
            morceaux.append('''func %s(%s) %s%s {
    return %s%s{__h: int(mooditEntier(mooditNouvelle("%s", []interface{}{%s})))}
}''' % (nom, params, "*" if pointeur else "", typ,
        "&" if pointeur else "", typ, nom, args))
        for retour, nom, types in methodes:
            params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            conv = GO_CONV[retour] % 'mooditMethode(o.__h, "%s.%s", []interface{}{%s})' % (typ, nom, args)
            morceaux.append('''func (o %s) %s(%s) %s {
    return %s
}''' % (typ, nom, params, retour, conv))
    return "\n\n".join(morceaux)


def go_object_dispatch(objets, champs=None):
    """Aiguillage OBJET côté étudiant : construit et appelle POUR DE VRAI. PURE (testée).

    Un type à champs capturés se construit par son littéral, exactement comme le ferait
    l'étudiant ; la clé `new` porte alors le NOM DU TYPE, et non celui d'un constructeur."""
    champs = champs or {}
    cas_new, cas_methode = [], []
    for typ, ctors, methodes in objets:
        if typ in champs:
            affectations = ", ".join(
                "%s: %s" % (n, GO_CONV[t] % ("req.Args[%d]" % i))
                for i, (n, t) in enumerate(champs[typ]))
            cas_new.append('        case "%s":\n'
                           '            mooditObjets = append(mooditObjets, &%s{%s})\n'
                           '            valeur = len(mooditObjets) - 1'
                           % (typ, typ, affectations))
            # Une fonction-constructeur renvoie les CHAMPS du résultat, pas une poignée : le
            # bouchon reconstruit alors une valeur simple, utilisable comme un littéral.
            for nom, types, _ in ctors:
                args = ", ".join(GO_CONV[t] % ("req.Args[%d]" % i) for i, t in enumerate(types))
                champs_retour = ", ".join("moodit_cree.%s" % n for n, _ in champs[typ])
                cas_new.append('        case "%s":\n'
                               '            moodit_cree := %s(%s)\n'
                               '            valeur = []interface{}{%s}'
                               % (nom, nom, args, champs_retour))
        else:
            # On garde un POINTEUR vers l'objet : une méthode à récepteur pointeur — l'idiome le
            # plus répandu — ne peut pas être appelée sur le résultat d'une assertion de type,
            # qui n'est pas adressable. Le programme de l'étudiant ne compilait pas, et il lisait
            # « Échec de compilation » pour du code qu'il n'avait pas écrit.
            for nom, types, pointeur in ctors:
                args = ", ".join(GO_CONV[t] % ("req.Args[%d]" % i) for i, t in enumerate(types))
                cas_new.append('        case "%s":\n'
                               '            moodit_cree := %s(%s)\n'
                               '            mooditObjets = append(mooditObjets, %smoodit_cree)\n'
                               '            valeur = len(mooditObjets) - 1'
                               % (nom, nom, args, "" if pointeur else "&"))
        for retour, nom, types in methodes:
            args = ", ".join(GO_CONV[t] % ("req.Args[%d]" % i) for i, t in enumerate(types))
            # `(*T)` : un récepteur valeur s'appelle aussi sur un pointeur (déréférencement
            # automatique), donc une seule forme suffit pour les deux.
            cas_methode.append('        case "%s.%s":\n'
                               '            valeur = mooditObjets[req.Handle].(*%s).%s(%s)'
                               % (typ, nom, typ, nom, args))
    return "\n".join(cas_new), "\n".join(cas_methode)


def go_grader_source(methods, harness_code, nonce, objets=(), champs=None):
    """Programme NOTEUR Go : bouchons typés + harnais booléen du prof + nonce. PURE (testée)."""
    bouchons = []
    for retour, nom, types in methods:
        params = ", ".join("a%d %s" % (i, t) for i, t in enumerate(types))
        args = ", ".join("a%d" % i for i in range(len(types)))
        # MÊME table que l'aiguillage et que les bouchons objets : trois copies divergentes ont
        # déjà produit trois défauts (deux contournements de l'encodage, une lecture en flottant).
        conv = GO_CONV[retour] % "v"
        bouchons.append("""func %s(%s) %s {
    v := mooditAppel("%s", []interface{}{%s})
    return %s
}""" % (nom, params, retour, nom, args, conv))
    return '''package main

import (
    "bufio"
    "crypto/rand"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "os"
    "strings"
)
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
                fmt.Fprintln(os.Stderr, "[MOODIT] harnais:", r)
                ok = false
            }
        }()
        ok = mooditHarnais()
    }()
    if ok {
        fmt.Fprint(os.Stderr, "%s")
    }
    if ok {
        os.Exit(0)
    }
    os.Exit(1)
}
''' % (GO_RPC_RUNTIME, "\n\n".join(bouchons), go_object_stub(objets, champs),
       "\n".join("    " + l if l.strip() else l for l in (harness_code or "").splitlines()),
       nonce)


def go_server_source(methods, objets=(), champs=None):
    """Serveur de l'étudiant : aiguillage TYPÉ vers ses fonctions et ses objets. PURE (testée).

    Aucun nonce, aucun harnais, aucun attendu : ce programme ne peut rien apprendre du verdict."""
    cas_new, cas_methode = go_object_dispatch(objets, champs)
    cas = []
    for retour, nom, types in methods:
        # UNE seule table de conversion, partagée avec l'aiguillage des objets et les bouchons du
        # noteur : cette boucle-ci avait la sienne, et elle est restée sur `mooditNombre` quand
        # les entiers sont passés à la lecture exacte — une somme au-delà de 2^53 revenait fausse
        # sur le chemin le plus courant, celui de l'appel de fonction.
        args = ", ".join(GO_CONV[t] % ("req.Args[%d]" % i) for i, t in enumerate(types))
        cas.append('        case "%s":\n            valeur = %s(%s)' % (nom, nom, args))
    return '''package main

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
''' % (GO_RPC_RUNTIME, cas_new or "        case \"\":", cas_methode or "        case \"\":",
       "\n".join(cas))


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

C_FUNC = re.compile(r"^\s*(int|long|double|float|char\s*\*)\s+(\w+)\s*\(([^)]*)\)\s*\{", re.M)
# `%.17g` et non `%g` : ce format est celui des ARGUMENTS comme des RETOURS, relus par atof.
# `%g` s'arrête à 6 chiffres significatifs — 3.14159265 arrivait tronqué chez l'étudiant et
# 1234567.89 revenait en notation exponentielle, donc une réponse JUSTE était notée fausse.
# 17 chiffres suffisent à garantir l'aller-retour exact d'un double IEEE 754.
C_TYPES = {"int": "%d", "long": "%ld", "double": "%.17g"}
# Lecture d'un champ texte, UNE seule fois pour les cinq sites qui en avaient une copie.
C_LECTURE = {"int": "atoi", "long": "atol", "double": "atof"}


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
    texte = source or ""
    profondeurs = [0] * len(texte)
    niveau = 0
    i = 0
    n = len(texte)
    bloc = 0            # profondeur des /* */
    while i < n:
        c = texte[i]
        if bloc:
            if texte.startswith("/*", i):
                bloc += 1
                profondeurs[i] = niveau
                profondeurs[i + 1] = niveau
                i += 2
                continue
            if texte.startswith("*/", i):
                bloc -= 1
                profondeurs[i] = niveau
                profondeurs[i + 1] = niveau
                i += 2
                continue
            profondeurs[i] = niveau
            i += 1
            continue
        if texte.startswith("//", i):
            fin = texte.find("\n", i)
            fin = n if fin < 0 else fin
            for j in range(i, fin):
                profondeurs[j] = niveau
            i = fin
            continue
        if texte.startswith("/*", i):
            bloc = 1
            profondeurs[i] = niveau
            profondeurs[i + 1] = niveau
            i += 2
            continue
        brut = re.match(r'r(#*)"', texte[i:]) or re.match(r'R"\(', texte[i:])
        if brut and (c in "rR"):
            if c == "r":
                dieses = brut.group(1)
                ferme = '"' + dieses
                debut = i + 1 + len(dieses) + 1
            else:
                ferme = ')"'
                debut = i + 3
            fin = texte.find(ferme, debut)
            fin = n if fin < 0 else fin + len(ferme)
            for j in range(i, fin):
                profondeurs[j] = niveau
            i = fin
            continue
        if c == "'" and not CHAR_LITERAL.match(texte, i):
            # L'apostrophe n'ouvre PAS toujours un littéral de caractère : durée de vie Rust
            # (`&'static str`), étiquette de boucle (`'ext: loop`), séparateur de chiffres C++
            # (`1'000`). La prendre pour une ouverture faisait ignorer les accolades jusqu'à la
            # fin de la ligne, décalait le compteur pour tout le reste du fichier, et les
            # fonctions suivantes disparaissaient : un code CORRECT rendait « aucune fonction
            # exploitable ». On ne la traite comme un littéral que si elle en a la FORME.
            profondeurs[i] = niveau
            i += 1
            continue
        if c in "\"'":
            profondeurs[i] = niveau
            j = i + 1
            while j < n:
                if texte[j] == "\\":
                    profondeurs[j] = niveau
                    if j + 1 < n:
                        profondeurs[j + 1] = niveau
                    j += 2
                    continue
                profondeurs[j] = niveau
                if texte[j] == c:
                    j += 1
                    break
                if texte[j] == "\n":
                    break        # chaîne non fermée : on ne mange pas le reste du fichier
                j += 1
            i = j
            continue
        if c == "}":
            niveau -= 1
        profondeurs[i] = niveau
        if c == "{":
            niveau += 1
        i += 1
    return profondeurs


def block_end(texte, debut):
    """Fin du bloc ouvert à `debut` (index de son `{`), par appariement LEXICAL. PURE (testée).

    Même balayage que `code_depths` — une accolade en littéral ou en commentaire ne compte pas —
    au lieu des trois copies naïves qu'en avaient les chemins Rust et C++."""
    profondeurs = code_depths(texte)
    niveau = profondeurs[debut]
    for i in range(debut + 1, len(texte)):
        if texte[i] == "}" and profondeurs[i] == niveau:
            return i
    return len(texte)


def cpp_class_spans(source):
    """Plages (début, fin) des corps de classe/structure C++. FONCTION PURE (testée).

    Sert à ne PAS prendre une méthode pour une fonction libre : `int aire() { … }` indenté dans
    une classe n'est pas appelable sans objet, et le bouchon généré ne compilait pas."""
    texte = source or ""
    plages = []
    for classe in CPP_CLASS.finditer(texte):
        try:
            debut = texte.index("{", classe.start())
        except ValueError:
            continue
        plages.append((debut, block_end(texte, debut)))
    return plages


def c_signatures(source, cpp=False):
    """Fonctions de premier niveau du code étudiant → [(retour, nom, [types])]. PURE (testée).

    Seuls int/long/double sont marshalés dans ce jalon ; `main` est écartée, ainsi que — en C++ —
    tout ce qui vit dans un corps de classe (ce sont des méthodes, proxifiées par poignée). Une
    signature hors liste n'est pas proxifiée : le harnais qui l'appelle ne compilera pas (message
    au prof, jamais un faux verdict)."""
    plages = cpp_class_spans(source) if cpp else []
    trouvees = []
    for trouve in C_FUNC.finditer(source or ""):
        if any(debut <= trouve.start() <= fin for debut, fin in plages):
            continue
        retour, nom, params = trouve.group(1), trouve.group(2), trouve.group(3)
        retour = retour.replace(" ", "")
        if nom == "main" or retour not in C_TYPES:
            continue
        types = []
        valide = True
        for groupe in [p.strip() for p in params.split(",") if p.strip() and p.strip() != "void"]:
            morceaux = groupe.replace("*", " ").split()
            if len(morceaux) < 2 or morceaux[0] not in C_TYPES:
                valide = False
                break
            types.append(morceaux[0])
        if not valide:
            continue
        trouvees.append((retour, nom, types))
    return trouvees


CPP_CLASS = re.compile(r"^\s*(?:class|struct)\s+(\w+)", re.M)


def cpp_object_api(source):
    """API OBJET C++ → [(classe, [constructeurs], [(retour, méthode, [types])])]. PURE (testée).

    Le corps de la classe est découpé par appariement d'accolades, et seules les déclarations de
    la section PUBLIQUE comptent (une `class` commence en privé, une `struct` en public)."""
    texte = source or ""
    resultat = []
    for classe in CPP_CLASS.finditer(texte):
        nom_classe = classe.group(1)
        try:
            debut = texte.index("{", classe.start())
        except ValueError:
            continue
        fin = block_end(texte, debut)
        corps = texte[debut + 1:fin]
        public = texte[classe.start():debut].lstrip().startswith("struct")
        ctors, methodes = [], []
        for ligne in corps.splitlines():
            nue = ligne.strip()
            if nue.startswith("public:"):
                public = True
                nue = nue[len("public:"):].strip()
            elif nue.startswith("private:") or nue.startswith("protected:"):
                public = False
                continue
            if not public or not nue:
                continue
            ctor = re.match(re.escape(nom_classe) + r"\s*\(([^)]*)\)", nue)
            if ctor:
                types = _c_param_types(ctor.group(1))
                if types is not None:
                    ctors.append(types)
                continue
            methode = re.match(r"(int|long|double)\s+(\w+)\s*\(([^)]*)\)", nue)
            if methode:
                types = _c_param_types(methode.group(3))
                if types is not None:
                    methodes.append((methode.group(1), methode.group(2), types))
        if ctors and methodes:
            resultat.append((nom_classe, ctors, methodes))
    return resultat


def _c_param_types(params):
    """Types des paramètres d'une signature C/C++, ou None si l'un n'est pas marshalable. PURE."""
    types = []
    for groupe in [p.strip() for p in params.split(",") if p.strip() and p.strip() != "void"]:
        morceaux = groupe.replace("*", " ").split()
        if len(morceaux) < 2 or morceaux[0] not in C_TYPES:
            return None
        types.append(morceaux[0])
    return types


def cpp_object_stub(objets):
    """Bouchons OBJET C++ : classe à poignée, constructeurs et méthodes relayés. PURE (testée)."""
    morceaux = []
    for classe, ctors, methodes in objets:
        corps = ["class %s {" % classe, "    int __h;", "public:"]
        for types in ctors:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            fmt = "".join("|" + C_TYPES[t] for t in types)
            args = "".join(", a%d" % i for i in range(len(types)))
            corps += ["    %s(%s) {" % (classe, params),
                      "        char id[40], requete[4096];",
                      "        moodit_identifiant(id);",
                      '        snprintf(requete, sizeof requete, "%%s|new|%s%s", id%s);'
                      % (classe, fmt, args),
                      "        moodit_envoie(requete);",
                      "        __h = atoi(moodit_valeur(id));",
                      "    }"]
        for retour, nom, types in methodes:
            params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
            fmt = "".join("|" + C_TYPES[t] for t in types)
            args = "".join(", a%d" % i for i in range(len(types)))
            lecture = C_LECTURE[retour]
            corps += ["    %s %s(%s) {" % (retour, nom, params),
                      "        char id[40], requete[4096];",
                      "        moodit_identifiant(id);",
                      '        snprintf(requete, sizeof requete, "%%s|method|%s.%s|%%d%s", id, __h%s);'
                      % (classe, nom, fmt, args),
                      "        moodit_envoie(requete);",
                      "        return %s(moodit_valeur(id));" % lecture,
                      "    }"]
        corps.append("};")
        morceaux.append("\n".join(corps))
    return "\n\n".join(morceaux)


def cpp_object_dispatch(objets):
    """Aiguillage OBJET côté étudiant : une pile PAR CLASSE, construction réelle. PURE (testée)."""
    piles, cas = [], []
    for classe, ctors, methodes in objets:
        piles.append("static std::vector<%s> moodit_objets_%s;" % (classe, classe))
        for types in ctors:
            lectures = "\n".join(
                "        %s a%d = %s(moodit_jeton());"
                % (t, i, C_LECTURE[t])
                for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            cas.append('''    if (strcmp(op, "new") == 0 && strcmp(nom, "%s") == 0) {
%s
        moodit_objets_%s.push_back(%s(%s));
        printf("\\n%%s|ok|%%d\\n", id, (int) moodit_objets_%s.size() - 1);
        fflush(stdout);
        return;
    }''' % (classe, lectures, classe, classe, args, classe))
        for retour, nom, types in methodes:
            lectures = "\n".join(
                "        %s a%d = %s(moodit_jeton());"
                % (t, i, C_LECTURE[t])
                for i, t in enumerate(types))
            args = ", ".join("a%d" % i for i in range(len(types)))
            cas.append('''    if (strcmp(op, "method") == 0 && strcmp(nom, "%s.%s") == 0) {
        int h = atoi(moodit_jeton());
%s
        printf("\\n%%s|ok|%s\\n", id, moodit_objets_%s[h].%s(%s));
        fflush(stdout);
        return;
    }''' % (classe, nom, lectures, C_TYPES[retour], classe, nom, args))
    return "\n".join(piles), "\n\n".join(cas)


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


def c_grader_source(methods, harness_code, nonce, cpp=False, objets=()):
    """Programme NOTEUR C/C++ : bouchons typés + harnais booléen + nonce. PURE (testée)."""
    bouchons = []
    for retour, nom, types in methods:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        fmt = "".join("|" + C_TYPES[t] for t in types)
        args = "".join(", a%d" % i for i in range(len(types)))
        lecture = C_LECTURE[retour]
        bouchons.append("""static %s %s(%s) {
    char id[40], requete[4096];
    moodit_identifiant(id);
    snprintf(requete, sizeof requete, "%%s|call|%s%s", id%s);
    moodit_envoie(requete);
    return %s(moodit_valeur(id));
}""" % (retour, nom, params or "void", nom, fmt, args, lecture))
    entete = "" if cpp else ""
    return entete + C_RUNTIME + r'''
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

''' + "\n\n".join(bouchons) + "\n\n" + cpp_object_stub(objets) + r'''

static int moodit_harnais(void) {
''' + "\n".join("    " + l if l.strip() else l
                for l in (harness_code or "").splitlines()) + r'''
}

int main(void) {
    if (moodit_harnais()) {
        fputs("''' + nonce + r'''", stderr);
        fflush(stderr);
        return 0;
    }
    return 1;
}
'''


def c_server_source(methods, student_source, cpp=False, objets=()):
    """Programme ÉTUDIANT C/C++ : son code (main renommé) + aiguillage typé. PURE (testée)."""
    cas = []
    for retour, nom, types in methods:
        lectures = []
        for i, t in enumerate(types):
            conv = C_LECTURE[t]
            lectures.append("        %s a%d = %s(moodit_jeton());" % (t, i, conv))
        args = ", ".join("a%d" % i for i in range(len(types)))
        cas.append("""    if (strcmp(op, "call") == 0 && strcmp(nom, "%s") == 0) {
%s
        printf("\\n%%s|ok|%s\\n", id, %s(%s));
        fflush(stdout);
        return;
    }""" % (nom, "\n".join(lectures), C_TYPES[retour], nom, args))
    piles, cas_objets = cpp_object_dispatch(objets)
    return ("#define main __moodit_student_main\n"
            + (student_source or "")
            + "\n#undef main\n"
            + ("#include <vector>\n" if objets else "")
            + C_RUNTIME + piles + r'''
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
''' + "\n".join(cas) + "\n\n" + cas_objets + r'''
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

RUST_FN = re.compile(r"^\s*(?:pub\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*->\s*([\w:]+)", re.M)
RUST_TYPES = {"i32": "i32", "i64": "i64", "f64": "f64", "bool": "bool", "String": "String"}


def rust_signatures(source):
    """Fonctions de PREMIER NIVEAU du code étudiant → [(retour, nom, [types])]. PURE (testée)."""
    profondeurs = code_depths(source)
    trouvees = []
    for trouve in RUST_FN.finditer(source or ""):
        nom, params, retour = trouve.group(1), trouve.group(2), trouve.group(3)
        if profondeurs[trouve.start(1)] != 0:
            continue    # fonction associée (impl) ou imbriquée : pas appelable au niveau module
        if nom == "main" or retour not in RUST_TYPES:
            continue
        types = []
        valide = True
        for groupe in [p.strip() for p in params.split(",") if p.strip()]:
            if ":" not in groupe:
                valide = False
                break
            t = groupe.split(":", 1)[1].strip()
            if t not in RUST_TYPES:
                valide = False
                break
            types.append(t)
        if valide:
            trouvees.append((retour, nom, types))
    return trouvees


RUST_STRUCT = re.compile(r"^\s*(?:pub\s+)?struct\s+(\w+)", re.M)
RUST_IMPL = re.compile(r"^\s*impl\s+(\w+)\s*\{", re.M)
RUST_FN_IN_IMPL = re.compile(
    r"^\s*(?:pub\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*->\s*([\w:]+)", re.M)
def rust_envoi(types):
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
    texte = source or ""
    structs = set(RUST_STRUCT.findall(texte))
    resultat = []
    for impl in RUST_IMPL.finditer(texte):
        typ = impl.group(1)
        if typ not in structs:
            continue
        debut = texte.index("{", impl.start())
        fin = block_end(texte, debut)
        corps = texte[debut:fin]
        ctors, methodes = [], []
        for nom, params, retour in RUST_FN_IN_IMPL.findall(corps):
            morceaux = [p.strip() for p in params.split(",") if p.strip()]
            prend_self = bool(morceaux) and morceaux[0].endswith("self")
            utiles = morceaux[1:] if prend_self else morceaux
            types = []
            valide = True
            for groupe in utiles:
                if ":" not in groupe or groupe.split(":", 1)[1].strip() not in RUST_TYPES:
                    valide = False
                    break
                types.append(groupe.split(":", 1)[1].strip())
            if not valide:
                continue
            if not prend_self and retour == typ:
                ctors.append((nom, types))
            elif prend_self and retour in RUST_TYPES:
                methodes.append((retour, nom, types))
        if methodes and (ctors or typ in rust_capture_fields(texte)):
            resultat.append((typ, ctors, methodes))
    return resultat


RUST_STRUCT_BODY = re.compile(r"^\s*(?:pub\s+)?struct\s+(\w+)\s*\{([^}]*)\}", re.M | re.S)


def rust_struct_fields(source):
    """Champs des structures du code étudiant → {type: [(champ, type)]}. PURE (testée).

    Comme en Go, l'idiome Rust d'une structure sans `new` est le LITTÉRAL À CHAMPS NOMMÉS
    (`Rectangle { largeur: 3, hauteur: 4 }`) : c'est la forme qu'écrivent les profs, donc celle
    qu'il faut savoir proxifier."""
    champs = {}
    for typ, corps in RUST_STRUCT_BODY.findall(source or ""):
        liste = []
        for groupe in corps.split(","):
            nue = groupe.split("//")[0].strip()
            if not nue:
                continue
            if ":" not in nue:
                liste = None
                break
            nom, type_ = (m.strip() for m in nue.split(":", 1))
            if type_ not in RUST_TYPES or not nom.isidentifier():
                liste = None
                break
            liste.append((nom, type_))
        if liste:
            champs[typ] = liste
    return champs


def rust_mut_receivers(source):
    """Types dont au moins une méthode prend `&mut self`. FONCTION PURE (testée).

    Pendant exact de `go_pointer_receivers` : une telle méthode peut modifier l'objet, et la
    capture de champs le reconstruit à chaque appel — la modification serait perdue EN SILENCE,
    donc un verdict faux sans diagnostic. Ces types passent par la poignée d'un constructeur."""
    texte = source or ""
    mutants = set()
    for impl in RUST_IMPL.finditer(texte):
        typ = impl.group(1)
        try:
            debut = texte.index("{", impl.start())
        except ValueError:
            continue
        fin = block_end(texte, debut)
        for _, params, _ in RUST_FN_IN_IMPL.findall(texte[debut:fin]):
            premier = (params.split(",")[0] if params else "").strip()
            if premier.replace(" ", "").startswith("&mutself"):
                mutants.add(typ)
    return mutants


def rust_capture_fields(source):
    """Champs CAPTURABLES : ceux des structures sans méthode `&mut self`. PURE (testée).

    Décision prise ICI et nulle part ailleurs, comme `go_capture_fields` : bouchon, aiguillage et
    lecture d'API doivent s'accorder."""
    mutants = rust_mut_receivers(source)
    return {t: f for t, f in rust_struct_fields(source).items() if t not in mutants}


def rust_object_stub(objets, champs=None):
    """Bouchons OBJET Rust : littéral à champs capturés ou poignée, et méthodes relayées.

    FONCTION PURE (testée). Champs tous marshalables → le bouchon les MIROITE et la méthode
    construit l'objet CHEZ l'étudiant au moment de l'appel ; sinon, poignée d'un constructeur."""
    champs = champs or {}
    morceaux = []
    for typ, ctors, methodes in objets:
        if typ in champs:
            declaration = "struct %s {\n%s\n}" % (
                typ, "\n".join("    %s: %s," % (n, t) for n, t in champs[typ]))
            # Les champs suivent la MÊME sérialisation que les arguments : le lecteur d'en face
            # déhexe, donc un champ String envoyé en clair revenait mutilé (une valeur commençant
            # par « H » surtout), et une réponse juste était notée fausse.
            envoi_champs = "".join(
                ' + "|" + &moodit_hexe(&self.%s)' % n if t == "String"
                else ' + "|" + &self.%s.to_string()' % n
                for n, t in champs[typ])
            corps = []
            # Une fonction associée CONSTRUCTRICE (Rectangle::new) reste proxifiée : elle
            # s'exécute chez l'étudiant et le bouchon relit les champs de son résultat.
            for nom, types in ctors:
                params = ", ".join("a%d: %s" % (i, t) for i, t in enumerate(types))
                envoi = rust_envoi(types)
                lectures = "\n".join(
                    "        let %s = %s;" % (n, RUST_CONV[t] % 'parts.next().unwrap_or("")')
                    for n, t in champs[typ])
                litteral = ", ".join(n for n, _ in champs[typ])
                corps.append('''    fn %s(%s) -> %s {
        let id = moodit_id();
        let brut = moodit_appel(&id, &(id.clone() + "|new|%s"%s));
        let mut parts = brut.split('|');
%s
        %s { %s }
    }''' % (nom, params, typ, nom, envoi, lectures, typ, litteral))
            for retour, nom, types in methodes:
                params = ", ".join(["&self"] + ["a%d: %s" % (i, t) for i, t in enumerate(types)])
                envoi = rust_envoi(types)
                parse = ("moodit_dehexe(brut.as_str())" if retour == "String"
                         else "brut.parse::<%s>().unwrap_or_default()" % retour)
                corps.append('''    fn %s(%s) -> %s {
        let cid = moodit_id();
        let h = moodit_appel(&cid, &(cid.clone() + "|new|%s"%s));
        let id = moodit_id();
        let requete = id.clone() + "|method|%s.%s|" + &h%s;
        let brut = moodit_appel(&id, &requete);
        %s
    }''' % (nom, params, retour, typ, envoi_champs, typ, nom, envoi, parse))
            morceaux.append("%s\n\nimpl %s {\n%s\n}"
                            % (declaration, typ, "\n\n".join(corps)))
            continue
        corps = []
        for nom, types in ctors:
            params = ", ".join("a%d: %s" % (i, t) for i, t in enumerate(types))
            envoi = rust_envoi(types)
            corps.append('''    fn %s(%s) -> %s {
        let id = moodit_id();
        let requete = id.clone() + "|new|%s"%s;
        %s { __h: moodit_appel(&id, &requete).parse::<i64>().unwrap_or_default() }
    }''' % (nom, params, typ, nom, envoi, typ))
        for retour, nom, types in methodes:
            params = ", ".join(["&self"] + ["a%d: %s" % (i, t) for i, t in enumerate(types)])
            envoi = rust_envoi(types)
            parse = ("moodit_dehexe(brut.as_str())" if retour == "String"
                     else "brut.parse::<%s>().unwrap_or_default()" % retour)
            # Ordre du protocole, commun à tous les langages à protocole texte :
            #   id|op|nom|poignée|args…   (la poignée ne vaut que pour `method`)
            corps.append('''    fn %s(%s) -> %s {
        let id = moodit_id();
        let requete = id.clone() + "|method|%s.%s|" + &self.__h.to_string()%s;
        let brut = moodit_appel(&id, &requete);
        %s
    }''' % (nom, params, retour, typ, nom, envoi, parse))
        morceaux.append("struct %s {\n    __h: i64,\n}\n\nimpl %s {\n%s\n}"
                        % (typ, typ, "\n\n".join(corps)))
    return "\n\n".join(morceaux)


def rust_object_dispatch(objets, champs=None):
    """Aiguillage OBJET côté étudiant : une pile PAR TYPE, pas d'unsafe. PURE (testée).

    Un type à champs capturés se construit par son littéral, comme l'écrirait l'étudiant ; la clé
    `new` porte alors le NOM DU TYPE et non celui d'un constructeur."""
    champs = champs or {}
    piles, cas = [], []
    for typ, ctors, methodes in objets:
        piles.append("    let mut moodit_%s: Vec<%s> = Vec::new();" % (typ.lower(), typ))
        if typ in champs:
            lectures = "\n".join(
                '                let %s = %s;' % (n, RUST_CONV[t] % 'args.next().unwrap_or("")')
                for n, t in champs[typ])
            litteral = "%s { %s }" % (typ, ", ".join(n for n, _ in champs[typ]))
            cas.append('''            "new|%s" => {
%s
                moodit_%s.push(%s);
                format!("{}|ok|{}", id, moodit_%s.len() - 1)
            }''' % (typ, lectures, typ.lower(), litteral, typ.lower()))
            for nom, types in ctors:
                lectures_args = "\n".join(
                    '                let a%d = %s;'
                    % (i, RUST_CONV[t] % 'args.next().unwrap_or("")')
                    for i, t in enumerate(types))
                appel = "%s::%s(%s)" % (typ, nom, ", ".join("a%d" % i for i in range(len(types))))
                retours = "".join(
                    '                                + "|" + &moodit_hexe(&moodit_cree.%s)' % n
                    if t == "String"
                    else '                                + "|" + &moodit_cree.%s.to_string()' % n
                    for n, t in champs[typ])
                cas.append('''            "new|%s" => {
%s
                let moodit_cree = %s;
                format!("{}|ok", id)
%s
            }''' % (nom, lectures_args, appel, retours))
        else:
            # Sans capture de champs, le constructeur rend une POIGNÉE. Les deux formes étaient
            # émises pour un type à champs capturés : le second bras, inatteignable, valait un
            # avertissement `unreachable_patterns` à la compilation.
            for nom, types in ctors:
                lectures = "\n".join(
                    '                let a%d = %s;'
                    % (i, RUST_CONV[t] % 'args.next().unwrap_or("")')
                    for i, t in enumerate(types))
                appel = "%s::%s(%s)" % (typ, nom,
                                        ", ".join("a%d" % i for i in range(len(types))))
                cas.append('''            "new|%s" => {
%s
                moodit_%s.push(%s);
                format!("{}|ok|{}", id, moodit_%s.len() - 1)
            }''' % (nom, lectures, typ.lower(), appel, typ.lower()))
        for retour, nom, types in methodes:
            # Les arguments de la méthode doivent être LUS et TRANSMIS : sans cela, le bouchon du
            # noteur les envoyait, l'appel généré ici était à vide, et rustc refusait le programme
            # de l'étudiant — « Échec de compilation » sur du code qu'il n'avait pas écrit.
            lectures_m = "\n".join(
                '                let a%d = %s;' % (i, RUST_CONV[t] % 'args.next().unwrap_or("")')
                for i, t in enumerate(types))
            passage = ", ".join("a%d" % i for i in range(len(types)))
            appel_m = "moodit_%s[h].%s(%s)" % (typ.lower(), nom, passage)
            if retour == "String":
                appel_m = "moodit_hexe(&%s)" % appel_m
            cas.append('''            "method|%s.%s" => {
                let h = args.next().unwrap_or("0").parse::<usize>().unwrap_or(0);
%s
                format!("{}|ok|{}", id, %s)
            }''' % (typ, nom, lectures_m, appel_m))
    return "\n".join(piles), "\n".join(cas)


def rust_grader_source(methods, harness_code, nonce, objets=(), champs=None):
    """Programme NOTEUR Rust : bouchons typés + harnais booléen + nonce. PURE (testée)."""
    bouchons = []
    for retour, nom, types in methods:
        params = ", ".join("a%d: %s" % (i, t) for i, t in enumerate(types))
        # Un raccourci « un seul argument » court-circuitait la sérialisation typée, donc
        # l'encodage des chaînes : `copie("a|b")` partait brut et décalait tout l'appel.
        corps = rust_envoi(types).replace(' + "|" + ', "", 1) or '""'
        parse = "moodit_dehexe(&brut)" if retour == "String" else "brut.parse::<%s>().unwrap()" % retour
        args = (" + \"|\" + " + corps) if types else ""
        bouchons.append('''fn %s(%s) -> %s {
    let id = moodit_id();
    let requete = id.clone() + "|%s"%s;
    let brut = moodit_appel(&id, &requete);
    %s
}''' % (nom, params, retour, nom, args, parse))
    return '''use std::io::{BufRead, Write};

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
        eprint!("%s");
        std::io::stderr().flush().unwrap();
        std::process::exit(0);
    }
    std::process::exit(1);
}
''' % ("\n\n".join(bouchons), rust_object_stub(objets, champs),
       "\n".join("    " + l if l.strip() else l for l in (harness_code or "").splitlines()),
       nonce)


def rust_server_source(methods, student_source, objets=(), champs=None):
    """Programme ÉTUDIANT Rust : son code + aiguillage typé (fonctions et objets). PURE (testée)."""
    piles, cas_objets = rust_object_dispatch(objets, champs)
    cas = []
    for retour, nom, types in methods:
        # MÊME table que les bouchons et l'aiguillage des objets (RUST_CONV) : une copie à part
        # est restée en arrière à chaque changement d'invariant, et c'est ainsi que l'encodage
        # des chaînes a été oublié une première fois.
        lectures = ['            let a%d = %s;' % (i, RUST_CONV[t] % 'args.next().unwrap_or("")')
                    for i, t in enumerate(types)]
        appel = "%s(%s)" % (nom, ", ".join("a%d" % i for i in range(len(types))))
        if retour == "String":
            appel = "moodit_hexe(&%s)" % appel
        cas.append('        "%s" => {\n%s\n            format!("{}|ok|{}", id, %s)\n        }'
                   % (nom, "\n".join(lectures), appel))
    return '''%s

use std::io::{BufRead, Write};

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
        // Protocole : id|op|nom|poignée|args… pour `new`/`method`, id|fonction|args… sinon.
        let cle = if premier == "new" || premier == "method" {
            format!("{}|{}", premier, args.next().unwrap_or(""))
        } else {
            premier.clone()
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
''' % (rust_without_main(student_source), piles, "\n".join(cas), cas_objets)


RUST_MAIN = re.compile(r"^\s*fn\s+main\s*\(\s*\)", re.M)


def rust_without_main(source):
    """Code étudiant dont le `main` est renommé : le serveur fournit le point d'entrée. PURE."""
    return RUST_MAIN.sub("fn __moodit_student_main()", source or "")


# ─────────────────── C# : bouchon et aiguillage TYPÉS, protocole texte ───────────────────
# mono autorise l'appel natif (dup2) et la réflexion : c'est précisément pourquoi le noteur doit
# vivre AILLEURS. Ici il n'y a plus rien à détourner dans le processus de l'étudiant.

# Visibilite indifferente, comme en Java : en C# une methode de classe est privee PAR DEFAUT,
# donc exiger `public` refusait l ecriture la plus naturelle d un exercice.
CS_METHOD = re.compile(
    r"(?:public\s+|internal\s+|protected\s+|private\s+)?static\s+"
    r"(int|long|double|bool|string)\s+(\w+)\s*\(([^)]*)\)", re.M)
CS_TYPES = {"int": "int", "long": "long", "double": "double", "bool": "bool", "string": "string"}


def cs_signatures(source):
    """Méthodes STATIQUES du code étudiant → [(retour, nom, [types])], visibilité indifférente. PURE (testée)."""
    trouvees = []
    for retour, nom, params in CS_METHOD.findall(source or ""):
        if nom == "Main":
            continue
        types = []
        valide = True
        for groupe in [p.strip() for p in params.split(",") if p.strip()]:
            morceaux = groupe.split()
            if len(morceaux) != 2 or morceaux[0] not in CS_TYPES:
                valide = False
                break
            types.append(morceaux[0])
        if valide:
            trouvees.append((retour, nom, types))
    return trouvees


def cs_envoi(types):
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


CS_LECTURE = {"int": "int.Parse(v)", "long": "long.Parse(v)",
              "double": "double.Parse(v, System.Globalization.CultureInfo.InvariantCulture)",
              "bool": "bool.Parse(v)", "string": "MooditRpc.Dehexe(v)"}


def cs_object_stub(classe, ctors, methodes):
    """Bouchons OBJET C# : constructeur → poignée, méthodes d'instance → appel sur la poignée.

    FONCTION PURE (testée). `new Rectangle(3, 4).Aire()` s'écrit naturellement dans le harnais,
    alors que l'objet vit dans le processus de l'étudiant."""
    morceaux = []
    for types in ctors:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        # Conversion EXPLICITE en culture invariante : une concaténation implicite passe par la
        # culture courante, où un double s'écrit « 3,14 » — illisible par le double.Parse
        # invariant d'en face, donc une réponse juste notée fausse.
        args = cs_envoi(types)
        morceaux.append('''    public %s(%s) {
        string id = MooditRpc.Id();
        __h = int.Parse(MooditRpc.Appel(id, id + "|new|%s"%s));
    }''' % (classe, params, classe, args))
    for retour, nom, types in methodes:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        # Conversion EXPLICITE en culture invariante : une concaténation implicite passe par la
        # culture courante, où un double s'écrit « 3,14 » — illisible par le double.Parse
        # invariant d'en face, donc une réponse juste notée fausse.
        args = cs_envoi(types)
        lecture = CS_LECTURE[retour].replace("v", "brut")
        morceaux.append('''    public %s %s(%s) {
        string id = MooditRpc.Id();
        string brut = MooditRpc.Appel(id, id + "|method|" + __h + "|%s"%s);
        return %s;
    }''' % (retour, nom, params, nom, args, lecture))
    return "\n\n".join(morceaux)


def cs_grader_source(methods, harness_code, nonce, classe, ctors=(), instance=()):
    """Programme NOTEUR C# : bouchons typés + harnais booléen + nonce. PURE (testée)."""
    bouchons = []
    for retour, nom, types in methods:
        params = ", ".join("%s a%d" % (t, i) for i, t in enumerate(types))
        # Conversion EXPLICITE en culture invariante : une concaténation implicite passe par la
        # culture courante, où un double s'écrit « 3,14 » — illisible par le double.Parse
        # invariant d'en face, donc une réponse juste notée fausse.
        args = cs_envoi(types)
        lecture = CS_LECTURE[retour].replace("v", "brut")
        bouchons.append('''    public static %s %s(%s) {
        string id = MooditRpc.Id();
        string brut = MooditRpc.Appel(id, id + "|%s"%s);
        return %s;
    }''' % (retour, nom, params, nom, args, lecture))
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
        byte[] brut = System.Text.Encoding.UTF8.GetBytes(s ?? "");
        return "H" + BitConverter.ToString(brut).Replace("-", "").ToLowerInvariant();
    }

    public static string Dehexe(string v) {
        v = (v ?? "").Trim();
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
            Console.Error.Write("%s");
            Console.Error.Flush();
            return 0;
        }
        return 1;
    }
}
''' % (classe, cs_object_stub(classe, ctors, instance), "\n\n".join(bouchons),
       "\n".join("        " + l if l.strip() else l
                 for l in (harness_code or "").splitlines()), nonce)


def cs_server_source(classe):
    """Programme ÉTUDIANT C# : son code (compilé à côté) + aiguillage par réflexion. PURE."""
    return '''using System;
using System.Reflection;

public static class MooditServer {
    // Objets construits CHEZ L'ÉTUDIANT : le noteur n'en connaît que la poignée.
    static readonly System.Collections.Generic.List<object> OBJETS =
        new System.Collections.Generic.List<object>();

    // Chaîne → HEXADÉCIMAL sur le fil : le protocole est à champs séparés par « | » et à une
    // ligne par message, donc un « | » ou un saut de ligne dans la valeur décalait tout l'appel.
    public static string Hexe(string s) {
        byte[] brut = System.Text.Encoding.UTF8.GetBytes(s ?? "");
        return "H" + BitConverter.ToString(brut).Replace("-", "").ToLowerInvariant();
    }

    public static string Dehexe(string v) {
        v = (v ?? "").Trim();
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
            if (attendus[i].ParameterType == typeof(string)) {
                donnes[i] = Dehexe(brut);
                continue;
            }
            donnes[i] = Convert.ChangeType(brut, attendus[i].ParameterType,
                    System.Globalization.CultureInfo.InvariantCulture);
        }
        return donnes;
    }

    /** Valeur de retour sur le fil : une chaîne part encodée. */
    static string Sortie(object v) {
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
                    foreach (var c in cible2.GetConstructors()) {
                        if (c.GetParameters().Length != parts.Length - 3) { continue; }
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
                    string nomMethode = parts[3];
                    MethodInfo cible3 = null;
                    foreach (MethodInfo m in instance.GetType().GetMethods()) {
                        if (m.Name == nomMethode && m.GetParameters().Length == parts.Length - 4) {
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
                foreach (MethodInfo m in typeof(%s).GetMethods(
                        BindingFlags.Public | BindingFlags.Static)) {
                    if (m.Name == nom && m.GetParameters().Length == parts.Length - 2) {
                        cible = m;
                        break;
                    }
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
''' % (classe, classe)


CS_CTOR_TPL = r"public\s+%s\s*\(([^)]*)\)"
CS_INSTANCE = re.compile(
    r"public\s+(?!static)(int|long|double|bool|string)\s+(\w+)\s*\(([^)]*)\)", re.M)


def cs_object_api(source, classe):
    """API OBJET d'une classe C# → ([constructeurs], [méthodes d'instance]). PURE (testée).

    Lue à la REGEX comme le reste du chemin C# : le prof n'a rien à déclarer, et une signature
    hors types marshalables est simplement écartée (le harnais qui l'appelle ne compilera pas)."""
    def types_de(params):
        resultat = []
        for groupe in [p.strip() for p in params.split(",") if p.strip()]:
            morceaux = groupe.split()
            if len(morceaux) != 2 or morceaux[0] not in CS_TYPES:
                return None
            resultat.append(morceaux[0])
        return resultat

    ctors = []
    for params in re.findall(CS_CTOR_TPL % re.escape(classe), source or ""):
        types = types_de(params)
        if types is not None:
            ctors.append(types)
    methodes = []
    for retour, nom, params in CS_INSTANCE.findall(source or ""):
        types = types_de(params)
        if types is not None and nom != "Main":
            methodes.append((retour, nom, types))
    return ctors, methodes


CS_CLASS = re.compile(r"(?:public\s+|static\s+)*class\s+(\w+)")


def cs_student_class(source):
    """Première classe déclarée par l'étudiant : celle que le harnais appellera. PURE (testée)."""
    trouve = CS_CLASS.search(source or "")
    return trouve.group(1) if trouve else "Solution"


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
        noteur = subprocess.Popen(grader_cmd, cwd=cwd, env=g_env, stdin=rep_r, stdout=req_w,
                                  stderr=g_err, preexec_fn=demote_grader)
        procs.append(noteur)
        etudiant = subprocess.Popen(student_cmd, cwd=cwd, env=s_env, stdin=req_r, stdout=rep_w,
                                    stderr=s_err, preexec_fn=demote_student)
        procs.append(etudiant)
        for fd in (req_r, req_w, rep_r, rep_w):
            os.close(fd)            # le parent lâche les quatre extrémités : EOF se propage
        expire = False
        try:
            code = noteur.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            code, expire = None, True
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
        return code, expire, read_capped(g_err_path), read_capped(s_err_path)
    except OSError as e:
        for fd in (req_r, req_w, rep_r, rep_w):
            try:
                os.close(fd)
            except OSError:
                pass
        ETAT_SORTIE.perdue = True
        event("espace_sature", case=ETAT_SORTIE.case, detail="lancement du couple impossible : %r" % e)
        return None, False, "", ""
    finally:
        for flux in (g_err, s_err):
            if flux is not None:
                try:
                    flux.close()
                except OSError:
                    ETAT_SORTIE.perdue = True


def run_java_rpc(case_dir, env, timeout_s, case_index):
    """Notation NON FALSIFIABLE d'un cas Java : harnais booléen, deux processus, deux UID.

    Le code étudiant est compilé SEUL (il ne voit jamais le harnais) ; ses signatures sont lues
    avec javap ; un bouchon de mêmes signatures est compilé AVEC le harnais du prof et le nonce.
    Verdict = le nonce est présent sur le stderr du noteur. L'étudiant ne peut pas le produire :
    il n'est ni dans son processus, ni dans ses fichiers, ni dans sa mémoire."""
    src = os.path.join(case_dir, "src")
    etu_src = os.path.join(case_dir, "etu_src")
    etu_classes = os.path.join(case_dir, "etu_classes")
    not_src = os.path.join(case_dir, "not_src")
    not_classes = os.path.join(case_dir, "not_classes")
    for d in (etu_src, etu_classes, not_src, not_classes):
        os.makedirs(d, exist_ok=True)

    # 1. Le code étudiant, SEUL. Son fichier harnais n'est même pas copié ici.
    student_file = None
    for nom in sorted(os.listdir(src)):
        if not nom.endswith(".java") or nom.startswith("Moodit"):
            continue
        with open(os.path.join(src, nom), "r", encoding="utf-8", errors="replace") as f:
            contenu = f.read()
        if "__MOODIT_HARNAIS__" in contenu:
            continue                      # le harnais du prof ne suit JAMAIS l'etudiant
        student_file = os.path.join(etu_src, nom)
        with open(student_file, "w", encoding="utf-8") as f:
            f.write(contenu)
    if student_file is None:
        return None, "Aucun fichier de code soumis"
    code, expire = run_proc(["javac", "-encoding", "UTF-8", "-d", etu_classes, student_file],
                            case_dir, env, COMPILE_TIMEOUT_S,
                            os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                            preexec_compile)
    if expire or code != 0:
        return None, "Échec de compilation :\n" + read_capped(os.path.join(case_dir, "cc.err"))[:1500]

    # 2. Signatures, lues sur les CLASSES compilées — le prof n'a rien à déclarer. On lit AUSSI
    #    les classes imbriquées (Outer$Inner), pour proxifier les objets : le harnais écrit
    #    `new Solution.Rectangle(3, 4).aire()` et l'objet vit, lui, chez l'étudiant.
    classe = os.path.basename(student_file)[:-len(".java")]
    binaires = sorted(nom[:-len(".class")] for nom in os.listdir(etu_classes)
                      if nom.endswith(".class") and not nom.startswith("Moodit"))
    code, expire = run_proc(["javap", "-p", "-cp", etu_classes] + binaires,
                            case_dir, env, LIST_TIMEOUT_S,
                            os.path.join(case_dir, "javap.out"), os.path.join(case_dir, "javap.err"),
                            preexec_compile)
    javap = read_capped(os.path.join(case_dir, "javap.out"))
    methodes = java_signatures(javap)
    # Une déclaration de classe par bloc : on les sépare pour lire l'API objet de chacune.
    objets = []
    soi_ctors, soi_instance = (), ()
    for bloc in re.split(r"(?=^Compiled from )", javap, flags=re.M):
        nom_source, ctors, instance = java_class_api(bloc)
        if not nom_source or not (ctors or instance):
            continue
        if nom_source == classe:
            # La classe publique peut ÊTRE l'objet à instancier (question POO dont la classe
            # s'appelle Rectangle) : son bouchon porte alors le constructeur et les méthodes.
            soi_ctors, soi_instance = ctors, instance
        else:
            objets.append((nom_source, ctors, instance))
    if expire or code != 0 or not (methodes or objets or (soi_ctors and soi_instance)):
        return None, ("Aucune méthode statique ni objet exploitable dans la classe "
                      + classe + " (types acceptés : int, long, double, boolean, String).")

    # 3. Le NOTEUR : bouchon + harnais du prof + nonce. Aucune ligne de code étudiant.
    harnais = ""
    for nom in sorted(os.listdir(src)):
        if nom.endswith(".java"):
            with open(os.path.join(src, nom), "r", encoding="utf-8", errors="replace") as f:
                contenu = f.read()
            if "__MOODIT_HARNAIS__" in contenu:
                harnais = contenu.split("__MOODIT_HARNAIS__", 1)[1].lstrip("\n")
    with open(os.path.join(not_src, classe + ".java"), "w", encoding="utf-8") as f:
        f.write(java_stub_source(classe, methodes, objets, soi_ctors, soi_instance))
    with open(os.path.join(not_src, "MooditGrader.java"), "w", encoding="utf-8") as f:
        f.write(java_grader_source(harnais, TOKENS.get(case_index) or ""))
    code, expire = run_proc(["javac", "-encoding", "UTF-8", "-d", not_classes,
                             os.path.join(not_src, classe + ".java"),
                             os.path.join(not_src, "MooditGrader.java")],
                            case_dir, env, COMPILE_TIMEOUT_S,
                            os.path.join(case_dir, "nc.out"), os.path.join(case_dir, "nc.err"),
                            preexec_compile)
    if expire or code != 0:
        return None, ("Le harnais ne compile pas contre la signature du code soumis :\n"
                      + read_capped(os.path.join(case_dir, "nc.err"))[:1500])

    # 4. Le serveur de l'étudiant, compilé AVEC ses classes.
    with open(os.path.join(etu_src, "MooditServer.java"), "w", encoding="utf-8") as f:
        f.write(java_server_source(classe))
    code, expire = run_proc(["javac", "-encoding", "UTF-8", "-cp", etu_classes, "-d", etu_classes,
                             os.path.join(etu_src, "MooditServer.java")],
                            case_dir, env, COMPILE_TIMEOUT_S,
                            os.path.join(case_dir, "sc.out"), os.path.join(case_dir, "sc.err"),
                            preexec_compile)
    if expire or code != 0:
        return None, "Erreur interne du noteur (serveur RPC)"

    # 5. CLOISONNEMENT : chacun chez soi, 700. L'étudiant ne peut pas lire le noteur (ni son
    #    binaire, ni sa source, ni — UID distinct — sa mémoire) ; le harnais du prof est hors
    #    d'atteinte par construction.
    lock_sources(src)
    for chemin in (not_src, not_classes):
        for racine, dossiers, fichiers in os.walk(chemin):
            for nom in dossiers + fichiers:
                os.chown(os.path.join(racine, nom), grader_uid(), grader_uid())
                os.chmod(os.path.join(racine, nom), 0o700)
        os.chown(chemin, grader_uid(), grader_uid())
        os.chmod(chemin, 0o700)
    for chemin in (etu_src, etu_classes):
        for racine, dossiers, fichiers in os.walk(chemin):
            for nom in dossiers + fichiers:
                os.chown(os.path.join(racine, nom), STUDENT_UID, STUDENT_GID)
                os.chmod(os.path.join(racine, nom), 0o700)
        os.chown(chemin, STUDENT_UID, STUDENT_GID)
        os.chmod(chemin, 0o700)
    prep_run(case_dir, src)

    # 6. Un HOME et un tmp PAR PROCESSUS, du bon propriétaire : une JVM sans tmpdir inscriptible
    #    ne démarre pas, et faire pointer le noteur dans le work/ de l'étudiant lui donnerait un
    #    point d'écriture commun — exactement ce qu'on cloisonne.
    work = os.path.join(case_dir, "work")
    os.makedirs(work, exist_ok=True)
    os.chmod(work, 0o755)
    etu_tmp = student_dir(work, "tmp")
    etu_home = student_dir(work, "home")
    not_tmp = os.path.join(work, "not_tmp")
    not_home = os.path.join(work, "not_home")
    for chemin in (not_tmp, not_home):
        os.makedirs(chemin, exist_ok=True)
        os.chown(chemin, grader_uid(), grader_uid())
        os.chmod(chemin, 0o700)
    g_env = dict(env, HOME=not_home, TMPDIR=not_tmp)
    s_env = dict(env, HOME=etu_home, TMPDIR=etu_tmp)

    # 7. Les deux processus, tubes croisés.
    code, expire, g_err, s_err = run_pair(
        ["java", "-XX:MaxRAMPercentage=35", "--illegal-native-access=deny",
         "--sun-misc-unsafe-memory-access=deny", "-Djava.io.tmpdir=" + not_tmp,
         "-cp", not_classes, "MooditGrader"],
        ["java", "-XX:MaxRAMPercentage=35", "--illegal-native-access=deny",
         "--sun-misc-unsafe-memory-access=deny", "-Djava.io.tmpdir=" + etu_tmp,
         "-cp", etu_classes, "MooditServer"],
        case_dir, g_env, s_env, timeout_s,
        os.path.join(case_dir, "grader.err"), os.path.join(case_dir, "student.err"))
    if expire:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None

    # Même verdict que le chemin commun : le message du NOTEUR d'abord — c'est le harnais du
    # prof qui a échoué, et présenter le stderr de l'étudiant désignait le mauvais fautif.
    passed, detail = rpc_verdict(TOKENS.get(case_index) or "", g_err, s_err)
    return CaseOutcome(passed, detail, ran=True), None


def run_csharp_rpc(case_dir, env, timeout_s, case_index):
    """Notation NON FALSIFIABLE d'un cas C# : harnais booléen, deux assemblages, deux UID.

    mono autorise l'appel natif et la réflexion — c'est exactement pourquoi le noteur est
    AILLEURS : il n'y a plus rien à détourner ni à inspecter dans le processus de l'étudiant."""
    src = os.path.join(case_dir, "src")
    student_source = ""
    for nom in sorted(os.listdir(src)):
        if nom == "solution.cs":
            with open(os.path.join(src, nom), "r", encoding="utf-8", errors="replace") as f:
                student_source = f.read()
    methodes = cs_signatures(student_source)
    classe = cs_student_class(student_source)
    ctors, instance = cs_object_api(student_source, classe)
    # Une question POO n'a AUCUNE méthode statique : son API, c'est le constructeur et les
    # méthodes d'instance. Exiger une statique refusait ces questions (dont celles de la démo).
    if not (methodes or (ctors and instance)):
        return None, ("Aucune méthode exploitable dans le code soumis : ni méthode statique, "
                      "ni constructeur avec méthode d'instance (types acceptés : int, long, "
                      "double, bool, string).")
    harnais = harness_rpc_body(case_dir) or ""

    etu_src = os.path.join(case_dir, "serveur.cs")
    not_src = os.path.join(case_dir, "noteur.cs")
    etu_copie = os.path.join(case_dir, "solution_etu.cs")
    with open(etu_copie, "w", encoding="utf-8") as f:
        f.write(student_source)
    with open(etu_src, "w", encoding="utf-8") as f:
        f.write(cs_server_source(classe))
    with open(not_src, "w", encoding="utf-8") as f:
        f.write(cs_grader_source(methodes, harnais, TOKENS.get(case_index) or "", classe,
                                 ctors, instance))
    bin_etu = os.path.join(case_dir, "etu.exe")
    bin_not = os.path.join(case_dir, "noteur.exe")
    for cmd, etiquette in (
            (["mcs", "-main:MooditServer", "-out:" + bin_etu, etu_src, etu_copie], "code soumis"),
            (["mcs", "-main:MooditGrader", "-out:" + bin_not, not_src], "harnais")):
        code, expire = run_proc(cmd, case_dir, env, COMPILE_TIMEOUT_S,
                                os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                                preexec_compile)
        if expire or code != 0:
            detail = (read_capped(os.path.join(case_dir, "cc.err"))
                      or read_capped(os.path.join(case_dir, "cc.out")))[:1500]
            if etiquette == "harnais":
                return None, "Le harnais ne compile pas contre le code soumis :\n" + detail
            return None, "Échec de compilation :\n" + detail
    os.chown(etu_copie, STUDENT_UID, STUDENT_GID)
    os.chmod(etu_copie, 0o600)
    return finish_rpc_pair(case_dir, env, timeout_s, case_index,
                           not_src, bin_not, etu_src, bin_etu,
                           grader_cmd=["mono", bin_not], student_cmd=["mono", bin_etu])


def run_rust_rpc(case_dir, env, timeout_s, case_index):
    """Notation NON FALSIFIABLE d'un cas Rust : harnais booléen, deux binaires, deux UID.

    Le harnais n'est plus dans le MÊME FICHIER que le code étudiant : `include_str!` n'a plus
    rien à inclure, et il n'y a plus de nonce dans ce processus."""
    src = os.path.join(case_dir, "src")
    student_source = ""
    for nom in sorted(os.listdir(src)):
        if nom == "solution.rs":
            with open(os.path.join(src, nom), "r", encoding="utf-8", errors="replace") as f:
                student_source = f.read()
    methodes = rust_signatures(student_source)
    objets = rust_object_api(student_source)
    champs = rust_capture_fields(student_source)
    if not (methodes or objets):
        return None, ("Aucune fonction exploitable dans le code soumis (types acceptés : i32, "
                      "i64, f64, bool, String).")
    harnais = harness_rpc_body(case_dir) or ""

    etu_src = os.path.join(case_dir, "etu.rs")
    not_src = os.path.join(case_dir, "noteur.rs")
    with open(etu_src, "w", encoding="utf-8") as f:
        f.write(rust_server_source(methodes, student_source, objets, champs))
    with open(not_src, "w", encoding="utf-8") as f:
        f.write(rust_grader_source(methodes, harnais, TOKENS.get(case_index) or "", objets, champs))
    bin_etu = os.path.join(case_dir, "etu_bin")
    bin_not = os.path.join(case_dir, "noteur_bin")
    for source, sortie, etiquette in ((etu_src, bin_etu, "code soumis"),
                                      (not_src, bin_not, "harnais")):
        code, expire = run_proc(["rustc", "-O", "--edition", "2021", source, "-o", sortie],
                                case_dir, env, COMPILE_TIMEOUT_S,
                                os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                                preexec_compile)
        if expire or code != 0:
            detail = read_capped(os.path.join(case_dir, "cc.err"))[:1500]
            if etiquette == "harnais":
                return None, "Le harnais ne compile pas contre le code soumis :\n" + detail
            return None, "Échec de compilation :\n" + detail
    return finish_rpc_pair(case_dir, env, timeout_s, case_index,
                           not_src, bin_not, etu_src, bin_etu)


def rpc_verdict(jeton, g_err, s_err):
    """Verdict d'un cas noté par le COUPLE noteur/étudiant. FONCTION PURE (testée).

    Le nonce du cas n'est détenu que par le noteur, qui ne l'émet sur SON stderr que si le harnais
    du prof a renvoyé vrai : sans nonce, échec (fail-closed), y compris si le noteur a planté ou
    si aucun jeton n'a été armé. Le détail privilégie le message du NOTEUR — c'est lui qui sait
    pourquoi le harnais a échoué ; le stderr de l'étudiant ne vient qu'ensuite, et il est choisi
    par lui, donc jamais présenté comme la cause."""
    passed = bool(jeton) and jeton in (g_err or "")
    if passed:
        return True, None
    detail = (first_lines(g_err or "", r"^\[MOODIT\]")
              or first_lines(s_err or "", r".")
              or "Le harnais a renvoyé faux")
    return False, detail


def finish_rpc_pair(case_dir, env, timeout_s, case_index, not_src, bin_not, etu_src, bin_etu,
                    grader_cmd=None, student_cmd=None):
    """Cloisonne les deux programmes, les lance en couple, rend le verdict.

    Partie COMMUNE à C/C++ et Rust (et à tout langage dont le noteur est un binaire) : chacun
    chez soi en 700 sous son UID, puis le nonce du noteur fait le verdict."""
    lock_sources(os.path.join(case_dir, "src"))
    for chemin, uid, mode in ((not_src, grader_uid(), 0o600), (bin_not, grader_uid(), 0o500),
                              (etu_src, STUDENT_UID, 0o600), (bin_etu, STUDENT_UID, 0o500)):
        if os.path.isdir(chemin):
            # Go travaille par MODULE : on cloisonne le dossier entier, récursivement.
            for racine, dossiers, fichiers in os.walk(chemin):
                for nom in dossiers + fichiers:
                    cible = os.path.join(racine, nom)
                    os.chown(cible, uid, uid)
                    os.chmod(cible, 0o700 if os.path.isdir(cible) else 0o600)
            os.chown(chemin, uid, uid)
            os.chmod(chemin, 0o700)
            continue
        os.chown(chemin, uid, uid)
        os.chmod(chemin, mode)
    prep_run(case_dir, os.path.join(case_dir, "src"))
    work = os.path.join(case_dir, "work")
    os.makedirs(work, exist_ok=True)
    os.chmod(work, 0o755)
    etu_tmp = student_dir(work, "tmp")
    not_tmp = os.path.join(work, "not_tmp")
    os.makedirs(not_tmp, exist_ok=True)
    os.chown(not_tmp, grader_uid(), grader_uid())
    os.chmod(not_tmp, 0o700)
    code, expire, g_err, s_err = run_pair(
        grader_cmd or [bin_not], student_cmd or [bin_etu], case_dir,
        dict(env, HOME=not_tmp, TMPDIR=not_tmp), dict(env, HOME=etu_tmp, TMPDIR=etu_tmp),
        timeout_s, os.path.join(case_dir, "grader.err"), os.path.join(case_dir, "student.err"))
    if expire:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    passed, detail = rpc_verdict(TOKENS.get(case_index) or "", g_err, s_err)
    return CaseOutcome(passed, detail, ran=True), None


def run_c_rpc(case_dir, env, timeout_s, case_index, compiler, std, ext):
    """Notation NON FALSIFIABLE d'un cas C/C++ : harnais booléen, deux binaires, deux UID.

    Le harnais n'est plus inclus dans l'unité de compilation du code étudiant : un
    `#define printf …` ne capture plus rien, et il n'y a plus de nonce à intercepter dans ce
    processus — c'est le résiduel in-process de C/C++ qui disparaît, pas qui se détecte."""
    src = os.path.join(case_dir, "src")
    student_source = ""
    for nom in sorted(os.listdir(src)):
        if nom.startswith("solution.") :
            with open(os.path.join(src, nom), "r", encoding="utf-8", errors="replace") as f:
                student_source = f.read()
    objets = cpp_object_api(student_source) if ext == "cpp" else []
    methodes = c_signatures(student_source, cpp=(ext == "cpp"))
    if not (methodes or objets):
        return None, ("Aucune fonction exploitable dans le code soumis "
                      "(types acceptés : int, long, double).")
    harnais = harness_rpc_body(case_dir) or ""

    etu_src = os.path.join(case_dir, "etu." + ext)
    not_src = os.path.join(case_dir, "noteur." + ext)
    with open(etu_src, "w", encoding="utf-8") as f:
        f.write(c_server_source(methodes, student_source, cpp=(ext == "cpp"), objets=objets))
    with open(not_src, "w", encoding="utf-8") as f:
        f.write(c_grader_source(methodes, harnais, TOKENS.get(case_index) or "",
                                cpp=(ext == "cpp"), objets=objets))
    bin_etu = os.path.join(case_dir, "etu_bin")
    bin_not = os.path.join(case_dir, "noteur_bin")
    for source, sortie, etiquette in ((etu_src, bin_etu, "code soumis"),
                                      (not_src, bin_not, "harnais")):
        code, expire = run_proc([compiler, std, "-O1", source, "-o", sortie, "-lm"],
                                case_dir, env, COMPILE_TIMEOUT_S,
                                os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"),
                                preexec_compile)
        if expire or code != 0:
            detail = read_capped(os.path.join(case_dir, "cc.err"))[:1500]
            if etiquette == "harnais":
                return None, "Le harnais ne compile pas contre le code soumis :\n" + detail
            return None, "Échec de compilation :\n" + detail

    return finish_rpc_pair(case_dir, env, timeout_s, case_index,
                           not_src, bin_not, etu_src, bin_etu)


def run_go_rpc(case_dir, env, timeout_s, case_index):
    """Notation NON FALSIFIABLE d'un cas Go : harnais booléen, deux binaires, deux UID."""
    src = os.path.join(case_dir, "src")
    etu = os.path.join(case_dir, "etu")
    noteur = os.path.join(case_dir, "noteur")
    for d in (etu, noteur):
        os.makedirs(d, exist_ok=True)

    student_source = ""
    for nom in sorted(os.listdir(src)):
        if nom.endswith(".go") and nom != "go.mod":
            with open(os.path.join(src, nom), "r", encoding="utf-8", errors="replace") as f:
                contenu = f.read()
            if "__MOODIT_HARNAIS__" not in contenu and "_test.go" not in nom:
                student_source = contenu
    methodes = go_signatures(student_source)
    objets = go_object_api(student_source)
    champs = go_capture_fields(student_source)
    if not (methodes or objets):
        return None, ("Aucune fonction exploitable dans le code soumis (types acceptés : int, "
                      "int64, float64, bool, string).")
    harnais = harness_rpc_body(case_dir) or ""

    # Deux modules Go indépendants : le harnais n'est NI compilé avec le code étudiant, NI
    # présent dans l'arborescence que son processus peut lire.
    with open(os.path.join(etu, "go.mod"), "w", encoding="utf-8") as f:
        f.write("module moodit_etu\n\ngo 1.23\n")
    with open(os.path.join(etu, "solution.go"), "w", encoding="utf-8") as f:
        f.write(go_student_without_main(student_source))
    with open(os.path.join(etu, "serveur.go"), "w", encoding="utf-8") as f:
        f.write(go_server_source(methodes, objets, champs))
    with open(os.path.join(noteur, "go.mod"), "w", encoding="utf-8") as f:
        f.write("module moodit_noteur\n\ngo 1.23\n")
    with open(os.path.join(noteur, "noteur.go"), "w", encoding="utf-8") as f:
        f.write(go_grader_source(methodes, harnais, TOKENS.get(case_index) or "", objets, champs))

    bin_etu = os.path.join(case_dir, "etu_bin")
    bin_not = os.path.join(case_dir, "noteur_bin")
    for dossier, sortie, etiquette in ((etu, bin_etu, "code soumis"),
                                       (noteur, bin_not, "harnais")):
        code, expire = run_proc(["go", "build", "-o", sortie, "."], dossier, env,
                                COMPILE_TIMEOUT_S, os.path.join(case_dir, "cc.out"),
                                os.path.join(case_dir, "cc.err"), preexec_compile)
        if expire or code != 0:
            detail = read_capped(os.path.join(case_dir, "cc.err"))[:1500]
            if etiquette == "harnais":
                return None, "Le harnais ne compile pas contre le code soumis :\n" + detail
            return None, "Échec de compilation :\n" + detail

    return finish_rpc_pair(case_dir, env, timeout_s, case_index,
                           noteur, bin_not, etu, bin_etu)


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
