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
    try:
        with open(path, "rb") as f:
            data = f.read(cap + 1)
        text = data.decode("utf-8", errors="replace")
        if len(data) > cap:
            text += "\n… (sortie tronquée)"
        return text
    except OSError:
        return ""


def demote_student():
    """preexec_fn du processus étudiant : UID dédié, groupe de processus, limites dures."""
    os.setsid()
    os.setgroups([])
    os.setgid(STUDENT_GID)
    os.setuid(STUDENT_UID)
    resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_LIMIT, FSIZE_LIMIT))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))


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


def run_proc(cmd, cwd, env, timeout_s, out_path, err_path, preexec, stdin_path=None):
    """Exécute cmd, sorties vers fichiers, kill du groupe au timeout. → (exit, timed_out)."""
    stdin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
    with open(out_path, "wb") as out, open(err_path, "wb") as err:
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
                pass
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


def scan_trace(trace_path, locked_dir, case_index):
    """Toute ouverture d'une source verrouillée par le processus étudiant = événement.
    Le chemin peut être absolu (/box/cases/<i>/src/…) ou relatif au cwd du cas ("src/…")."""
    if not trace_path or not os.path.exists(trace_path):
        return
    try:
        with open(trace_path, "r", errors="replace") as f:
            for line in f:
                if "openat(" not in line and "open(" not in line and "readlink" not in line:
                    continue
                if locked_dir in line or '"src/' in line or '"./src/' in line:
                    event("lecture_source_tentee", case=case_index, detail=line.strip()[:300])
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
    def __init__(self, passed, detail=None, ran=False):
        self.passed = passed
        self.detail = detail
        self.ran = ran  # le run a eu lieu (≠ échec de compilation) — utilisé par les canaris


def prep_run(case_dir, src):
    """Après compilation : sources verrouillées, chemins du cas traversables, dossier work."""
    lock_sources(src)
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
        os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"), None)
    if timed_out or code != 0:
        return None, "Échec de compilation :\n" + read_capped(os.path.join(case_dir, "cc.err"))[:1500]
    prep_run(case_dir, src)
    open_artifacts(tests_bin)
    exit_code, t_out, stdout, stderr, trace = run_student([tests_bin], case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True), None
    summary = re.search(r"^\[MOODIT\] summary total=(\d+) failed=(\d+)$", stdout, re.M)
    coherent = summary is not None and int(summary.group(1)) > 0
    passed = exit_code == 0 and coherent and int(summary.group(2)) == 0
    if exit_code == 0 and not coherent:
        event("rapport_incoherent", case=case_index, detail="exit 0 sans sommaire moodit_check")
    detail = None if passed else (first_lines(stdout, r"^\[MOODIT\] fail ")
                                  or first_lines(stderr, r".") or "Échec du harnais")
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
        os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"), None)
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
         "-cp", junit + ":" + classes, "org.junit.platform.console.ConsoleLauncher",
         "execute", "--scan-class-path", "--include-classname=.*",
         "--fail-if-no-tests", "--disable-banner", "--details=summary",
         "--reports-dir", reports],
        case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True), None
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
    return CaseOutcome(passed, detail, ran=True), None


def run_csharp(case_dir, env, timeout_s, case_index):
    src = os.path.join(case_dir, "src")
    exe = os.path.join(case_dir, "tests.exe")
    sources = glob.glob(os.path.join(src, "*.cs"))
    code, timed_out = run_proc(
        ["mcs", "-r:/opt/moodit/nunit.framework.dll", "-r:/opt/moodit/nunitlite.dll",
         "-main:MooditRunner", "-out:" + exe] + sources,
        case_dir, env, COMPILE_TIMEOUT_S,
        os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"), None)
    if timed_out or code != 0:
        return None, ("Échec de compilation :\n"
                      + (read_capped(os.path.join(case_dir, "cc.err"))
                         or read_capped(os.path.join(case_dir, "cc.out")))[:1500])
    prep_run(case_dir, src)
    open_artifacts(exe)
    result_xml = os.path.join(case_dir, "work", "nunit.xml")
    exit_code, t_out, stdout, stderr, trace = run_student(
        ["mono", exe, "--result:" + result_xml],
        case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True), None
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
    return CaseOutcome(passed, detail, ran=True), None


def run_go(case_dir, env, timeout_s, case_index):
    src = os.path.join(case_dir, "src")
    tests_bin = os.path.join(case_dir, "tests")
    code, timed_out = run_proc(
        ["go", "test", "-count=1", "-c", "-o", tests_bin, "."],
        src, env, COMPILE_TIMEOUT_S,
        os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"), None)
    if timed_out or code != 0:
        return None, ("Échec de compilation :\n"
                      + (read_capped(os.path.join(case_dir, "cc.err"))
                         or read_capped(os.path.join(case_dir, "cc.out")))[:1500])
    prep_run(case_dir, src)
    open_artifacts(tests_bin)
    exit_code, t_out, stdout, stderr, trace = run_student(
        [tests_bin, "-test.v", "-test.count=1"], case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True), None
    ran_tests = len(re.findall(r"^=== RUN\s", stdout, re.M))
    coherent = re.search(r"^PASS$", stdout, re.M) is not None and ran_tests > 0
    failed = (re.search(r"^--- FAIL", stdout, re.M) is not None
              or re.search(r"^FAIL$", stdout, re.M) is not None)
    passed = exit_code == 0 and coherent and not failed
    if exit_code == 0 and not coherent:
        event("rapport_incoherent", case=case_index, detail="exit 0 sans sommaire PASS de go test")
    detail = None if passed else (first_lines(stdout, r"_test\.go:\d+:|^--- FAIL|panic:")
                                  or first_lines(stderr, r".") or "Échec du harnais go test")
    return CaseOutcome(passed, detail, ran=True), None


def run_rust(case_dir, env, timeout_s, case_index):
    src = os.path.join(case_dir, "src")  # projet cargo complet (Cargo.toml + src/lib.rs)
    build_out = os.path.join(case_dir, "cc.out")
    code, timed_out = run_proc(
        ["cargo", "test", "--offline", "--no-run", "--message-format=json"],
        src, env, COMPILE_TIMEOUT_S, build_out, os.path.join(case_dir, "cc.err"), None)
    if timed_out or code != 0:
        err = read_capped(os.path.join(case_dir, "cc.err"))
        human = first_lines(err, r"error(\[|:)", 12) or err[:1500]
        return None, "Échec de compilation :\n" + human
    tests_bin = None
    for line in read_capped(build_out).splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if (msg.get("reason") == "compiler-artifact" and msg.get("profile", {}).get("test")
                and msg.get("executable")):
            tests_bin = msg["executable"]
    if not tests_bin or not os.path.exists(tests_bin):
        return None, "Binaire de test introuvable après compilation"
    prep_run(case_dir, src)
    os.chmod(tests_bin, 0o755)
    make_traversable(tests_bin, case_dir)
    exit_code, t_out, stdout, stderr, trace = run_student(
        [tests_bin, "--test-threads=1"], case_dir, env, timeout_s, "run")
    scan_trace(trace, src, case_index)
    if t_out:
        return CaseOutcome(False, "Interrompu (temps limite dépassé)", ran=True), None
    summary = re.search(r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed", stdout, re.M)
    coherent = summary is not None and (int(summary.group(2)) + int(summary.group(3))) > 0
    passed = (exit_code == 0 and coherent and summary.group(1) == "ok"
              and int(summary.group(3)) == 0)
    if exit_code == 0 and not coherent:
        event("rapport_incoherent", case=case_index, detail="exit 0 sans sommaire cargo test")
    detail = None if passed else (first_lines(stdout, r"panicked at|^failures:|^---- ")
                                  or first_lines(stderr, r".") or "Échec du harnais cargo test")
    return CaseOutcome(passed, detail, ran=True), None


RUNNERS = {
    "c": run_c,
    "cpp": run_cpp,
    "java": run_java,
    "csharp": run_csharp,
    "go": run_go,
    "rust": run_rust,
}


def substitute_canary(case_dir, a, b):
    """Remplace les gabarits __MOODIT_A__/__MOODIT_B__ du harnais canari par les valeurs tirées."""
    for root, _, files in os.walk(os.path.join(case_dir, "src")):
        for name in files:
            path = os.path.join(root, name)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            if "__MOODIT_A__" in content or "__MOODIT_B__" in content:
                content = content.replace("__MOODIT_A__", str(a)).replace("__MOODIT_B__", str(b))
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
        return None, ["go", "run", entry]
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

    cases = job["cases"]
    # Canaris : valeurs tirées MAINTENANT (imprévisibles), ordre d'exécution mélangé.
    rng = random.SystemRandom()
    for case in cases:
        case_dir = os.path.join(BOX, "cases", str(case["index"]))
        if case.get("canary") == "pass":
            a = rng.randrange(100000, 999999)
            substitute_canary(case_dir, a, a)
        elif case.get("canary") == "fail":
            a = rng.randrange(100000, 999999)
            substitute_canary(case_dir, a, a + 1 + rng.randrange(1000))
    order = list(cases)
    rng.shuffle(order)

    outcomes = {}
    timings = {}
    for case in order:
        try:
            outcome, ms = execute_case(language, case, timeout_s)
        except Exception as e:  # défaut du superviseur : fail-closed, jamais de faux « réussi »
            log("superviseur: exception sur le cas %s : %r" % (case["index"], e))
            outcome, ms = CaseOutcome(False, "Erreur interne du noteur", ran=False), 0
            event("erreur_superviseur", case=case["index"], detail=repr(e))
        outcomes[case["index"]] = outcome
        timings[case["index"]] = ms

    # Verdict des canaris : significatif seulement si leurs runs ont eu lieu (sinon l'échec de
    # compilation du code étudiant les explique déjà, et les vrais cas échouent de toute façon).
    canaries = "aucun"
    canary_cases = [c for c in cases if c.get("canary")]
    if canary_cases:
        if all(outcomes[c["index"]].ran for c in canary_cases):
            ok = all(outcomes[c["index"]].passed == (c["canary"] == "pass") for c in canary_cases)
            canaries = "ok" if ok else "incoherents"
            if not ok:
                event("canari_incoherent",
                      detail="résultat des canaris contraire à l'attendu — falsification probable")
        else:
            canaries = "indetermines"

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
