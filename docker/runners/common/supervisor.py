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
DEFAULT_RUN_TIMEOUT_S = 10
MAX_RUN_TIMEOUT_S = 60
OUTPUT_CAP = 64 * 1024          # tronque ce qu'on relit des sorties capturées
FSIZE_LIMIT = 32 * 1024 * 1024  # borne les fichiers écrits par le processus étudiant

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
    """Cas canari : SA classe seulement ; cas réel : tout le classpath."""
    name = CANARY_NAMES.get(case_index)
    return ["--select-class=" + name] if name else ["--scan-class-path"]


def nunit_selection(case_index):
    """Cas canari : SA classe seulement (NUnitLite `--test=`)."""
    name = CANARY_NAMES.get(case_index)
    return ["--test=" + name] if name else []


def libtest_selection(case_index):
    """Cas canari : son test ET celui du jeton (libtest accepte plusieurs filtres --exact)."""
    name = CANARY_NAMES.get(case_index)
    if not name:
        return []
    return ["--exact", "m%s::t%s" % (name, name), "zzzz_moodit_jeton::zzzz_jeton"]


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
    """Verdict des canaris, FONCTION PURE (couverte par test_supervisor.py) :
    « aucun » (pas de canaris), « ok », « incoherents » (résultat contraire à l'attendu, OU
    canaris non exécutés alors que des cas réels ont tourné — faire échouer la compilation des
    seuls canaris, p. ex. par collision de nom de classe, est une falsification : fail-closed),
    « indetermines » (rien n'a tourné : échec de compilation global, honnête)."""
    canary_cases = [c for c in cases if c.get("canary")]
    if not canary_cases:
        return "aucun"
    if all(outcomes[c["index"]].ran for c in canary_cases):
        ok = all(outcomes[c["index"]].passed == (c["canary"] == "pass") for c in canary_cases)
        if not ok:
            if all(outcomes[c["index"]].timed_out for c in cases):
                # TOUT a expiré, cas réels compris : temps limite trop court pour le langage ou
                # hôte surchargé — pas une falsification (un sabotage qui gèle tout tue aussi
                # les cas réels, aucun gain). Pas de fausse accusation.
                return "indetermines"
            event("canari_incoherent",
                  detail="résultat des canaris contraire à l'attendu — falsification probable")
        return "ok" if ok else "incoherents"
    if any(outcomes[c["index"]].skipped for c in canary_cases):
        # Canari SAUTÉ faute de budget global (l'ordre est tiré au sort : n'importe quel cas
        # peut tomber dans la queue non exécutée). Rien à reprocher à l'étudiant — sa
        # soumission est seulement trop lente, et les cas sautés comptent déjà échoués.
        return "indetermines"
    if any(outcomes[c["index"]].ran for c in cases if not c.get("canary")):
        event("canari_incoherent",
              detail="canaris non exécutés alors que des cas réels ont tourné")
        return "incoherents"
    return "indetermines"


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


def run_proc(cmd, cwd, env, timeout_s, out_path, err_path, preexec, stdin_path=None):
    """Exécute cmd, sorties vers fichiers, kill du groupe au timeout. → (exit, timed_out)."""
    stdin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
    with open_output(out_path) as out, open_output(err_path) as err:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=out, stderr=err,
                                stdin=stdin, preexec_fn=preexec)
        if stdin is not subprocess.DEVNULL:
            stdin.close()
        try:
            code = proc.wait(timeout=timeout_s)
            return code, False
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                # Pas de groupe dédié (preexec sans setsid) : au moins tuer le processus
                # lui-même, sinon proc.wait() bloque pour toujours et tout le job meurt en 502.
                proc.kill()
            proc.wait()
            return None, True


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
STRACE_OK = None  # déterminé au premier run


def run_student(cmd, case_dir, env, timeout_s, tag):
    """Exécute `cmd` sous l'UID student (via strace -u si disponible) ; renvoie
    (exit, timed_out, stdout, stderr, trace_path)."""
    global STRACE_OK
    out_path = os.path.join(case_dir, tag + ".out")
    err_path = os.path.join(case_dir, tag + ".err")
    # HOME/TMP de la phase de RUN : sous work/, possédés par l'étudiant (séparés du build).
    env = dict(env)
    env["HOME"] = student_dir(os.path.join(case_dir, "work"), "home")
    env["TMPDIR"] = student_dir(os.path.join(case_dir, "work"), "tmp")
    if STRACE and STRACE_OK is not False:
        trace_path = os.path.join(case_dir, tag + ".trace")
        wrapped = [STRACE, "-f", "-qq", "-e", "trace=openat,open,readlink,readlinkat",
                   "-o", trace_path, "-u", "student"] + cmd
        code, timed_out = run_proc(wrapped, case_dir, env, timeout_s, out_path, err_path, preexec_root)
        if STRACE_OK is None:
            # strace inutilisable (capacité SYS_PTRACE absente) → échec immédiat sans trace.
            STRACE_OK = os.path.exists(trace_path) and os.path.getsize(trace_path) > 0
            if not STRACE_OK:
                event("trace_indisponible")
                return run_student(cmd, case_dir, env, timeout_s, tag)
        return code, timed_out, read_capped(out_path), read_capped(err_path), trace_path
    code, timed_out = run_proc(cmd, case_dir, env, timeout_s, out_path, err_path, demote_student)
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
                       '"' + os.path.basename(binary) + '"']
    try:
        with open(trace_path, "r", errors="replace") as f:
            for line in f:
                if "openat(" not in line and "open(" not in line and "readlink" not in line:
                    continue
                if locked_dir in line or '"src/' in line or '"./src/' in line:
                    event("lecture_source_tentee", case=case_index, detail=line.strip()[:300])
                    return
                if probes and ("/proc/self/exe" in line or any(p in line for p in probes)):
                    event("lecture_binaire_tentee", case=case_index, detail=line.strip()[:300])
                    return
    except OSError:
        pass


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
    def __init__(self, passed, detail=None, ran=False, timed_out=False, skipped=False):
        self.passed = passed
        self.detail = detail
        self.ran = ran  # le run a eu lieu (≠ échec de compilation) — utilisé par les canaris
        self.timed_out = timed_out  # temps limite dépassé — utilisé par le verdict des canaris
        self.skipped = skipped  # cas SAUTÉ faute de budget global (ni tenté, ni fautif)


# Nom du test canari tiré au sort, par index de cas (vide pour un cas réel). Sert à
# N'EXÉCUTER QUE LUI dans un cas canari : le code étudiant y est compilé, donc SES PROPRES
# tests unitaires (idiome courant en Rust/Java/C#) étaient découverts et exécutés — un test
# d'étudiant simplement FAUX faisait échouer le canari « pass », et toute la soumission était
# refusée pour « falsification probable ». Les init/constructeurs du code étudiant tournent
# toujours au chargement : le forgeage qu'il s'agit d'attraper reste détecté.
CANARY_NAMES = {}

# Jeton de fin d'exécution par cas (substitué dans les sources, imprimé après tous les tests).
TOKENS = {}


def enforce_token(passed, detail, stdout, case_index):
    """Un verdict « réussi » exige le jeton de fin d'exécution dans la sortie : il n'est imprimé
    qu'APRÈS tous les tests par le point de sortie du framework — un rapport forgé suivi d'un
    exit(0) depuis le code étudiant ne l'a pas. Absent alors que tout le reste est cohérent :
    échec + événement."""
    token = TOKENS.get(case_index)
    if not passed or not token or ("[MOODIT] jeton=" + token) in stdout:
        return passed, detail
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
    summary = re.search(r"^\[MOODIT\] summary total=(\d+) failed=(\d+)$", stdout, re.M)
    coherent = summary is not None and int(summary.group(1)) > 0
    passed = exit_code == 0 and coherent and int(summary.group(2)) == 0
    if exit_code == 0 and not coherent:
        event("rapport_incoherent", case=case_index, detail="exit 0 sans sommaire moodit_check")
    detail = None if passed else (first_lines(stdout, r"^\[MOODIT\] fail ")
                                  or first_lines(stderr, r".") or "Échec du harnais")
    passed, detail = enforce_token(passed, detail, stdout, case_index)
    return CaseOutcome(passed, detail, ran=True), None


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
    exit_code, t_out, stdout, stderr, trace = run_student(
        ["java", "-XX:MaxRAMPercentage=50",
         "-Djava.io.tmpdir=" + os.path.join(case_dir, "work", "tmp"),
         # MooditMain (généré par HarnessProjects) enveloppe le ConsoleLauncher : il imprime le
         # jeton de fin APRÈS l'exécution — un System.exit(0) forgé le saute.
         "-cp", junit + ":" + classes, "MooditMain",
         "execute"] + junit_selection(case_index) + ["--include-classname=.*",
         "--fail-if-no-tests", "--disable-banner", "--details=summary",
         "--reports-dir", reports],
        case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    tests = failures = 0
    xml_ok = False
    for report in glob.glob(os.path.join(reports, "TEST-*.xml")):
        try:
            root = ET.parse(report).getroot()
            tests += int(root.get("tests", "0"))
            failures += int(root.get("failures", "0")) + int(root.get("errors", "0"))
            xml_ok = True
        except (ET.ParseError, OSError):
            pass
    passed = exit_code == 0 and xml_ok and tests > 0 and failures == 0
    if exit_code == 0 and (not xml_ok or tests == 0):
        event("rapport_incoherent", case=case_index, detail="exit 0 sans rapport JUnit exploitable")
    detail = None if passed else (first_lines(stdout, r"MethodSource|expected|Failures")
                                  or first_lines(stderr, r".") or "Échec du harnais JUnit")
    passed, detail = enforce_token(passed, detail, stdout, case_index)
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
    exit_code, t_out, stdout, stderr, trace = run_student(
        ["mono", exe, "--result:" + result_xml] + nunit_selection(case_index),
        case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    xml_passed = None
    total = 0
    try:
        root = ET.parse(result_xml).getroot()
        xml_passed = root.get("result") == "Passed"
        total = int(root.get("testcasecount", "0"))
    except (ET.ParseError, OSError):
        pass
    passed = exit_code == 0 and xml_passed is True and total > 0
    if exit_code == 0 and xml_passed is not True:
        event("rapport_incoherent", case=case_index, detail="exit 0 sans rapport NUnit « Passed »")
    detail = None if passed else (first_lines(stdout, r"Failed|Error|Exception")
                                  or first_lines(stderr, r".") or "Échec du harnais NUnit")
    passed, detail = enforce_token(passed, detail, stdout, case_index)
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
    failed = (re.search(r"^--- FAIL", stdout, re.M) is not None
              or re.search(r"^FAIL$", stdout, re.M) is not None)
    passed = exit_code == 0 and coherent and not failed
    if exit_code == 0 and not coherent:
        event("rapport_incoherent", case=case_index, detail="exit 0 sans sommaire PASS de go test")
    detail = None if passed else (first_lines(stdout, r"_test\.go:\d+:|^--- FAIL|panic:")
                                  or first_lines(stderr, r".") or "Échec du harnais go test")
    passed, detail = enforce_token(passed, detail, stdout, case_index)
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


def rust_verdict(exit_code, stdout):
    """Verdict d'un cas Rust — FONCTION PURE (couverte par test_supervisor.py).
    → (passed, incohérence ou None).

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
    exit_code, t_out, stdout, stderr, trace = run_student(
        [tests_bin, "--test-threads=1", "--nocapture"] + libtest_selection(case_index),
        case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index, binaries=(tests_bin,))
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True, timed_out=True), None
    passed, incoherence = rust_verdict(exit_code, stdout)
    if incoherence:
        event("rapport_incoherent", case=case_index, detail=incoherence)
    # --nocapture (requis pour le jeton) : les messages de panique partent sur STDERR au fil de
    # l'eau — on les y cherche d'abord, la liste `failures:` de stdout est maigre sans eux.
    detail = None if passed else (first_lines(stderr, r"panicked at")
                                  or first_lines(stdout, r"panicked at|^failures:|^---- ")
                                  or first_lines(stderr, r".") or "Échec du harnais cargo test")
    passed, detail = enforce_token(passed, detail, stdout, case_index)
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
    case_dir = os.path.join(BOX, "cases", str(case["index"]))
    runner = RUNNERS[language]
    env = base_env(case_dir)
    os.makedirs(env["HOME"], exist_ok=True)
    os.makedirs(env["TMPDIR"], exist_ok=True)
    start = time.monotonic()
    outcome, compile_error = runner(case_dir, env, timeout_s, case["index"])
    elapsed_ms = int((time.monotonic() - start) * 1000)
    if compile_error is not None:
        return CaseOutcome(False, compile_error, ran=False), elapsed_ms
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
            outcome, ms = CaseOutcome(False, "Erreur interne du noteur", ran=False), 0
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
                        "passed": bool(passed), "detail": detail,
                        "ms": timings[case["index"]]})

    print(json.dumps({"v": 1, "results": results, "events": EVENTS, "canaries": canaries},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
