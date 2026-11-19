package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.sandbox.DockerSandbox;
import com.moodit.execution_service.sandbox.RunnerExec;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Tests d'INTÉGRATION comportementaux : exercent le VRAI code Java (assemblage + verdict) contre
 * les VRAIES images runner (mode exec, ex-Piston). Contrairement aux tests unitaires (qui ne
 * vérifient que la STRUCTURE des chaînes générées), ceux-ci prouvent que les programmes assemblés
 * s'exécutent et notent correctement — notamment que l'ISOLATION RPC des langages interprétés
 * ferme le résiduel (une réponse fausse qui tente d'extraire le nonce ÉCHOUE).
 *
 * <p>Requiert un démon Docker joignable et les images {@code moodit-runner-*}
 * ({@code docker/runners/build.sh}). Le comportement quand une précondition manque dépend de
 * {@code SANDBOX_REQUIRED} :
 * <ul>
 *   <li><b>absent / false</b> (dev local) : le test est <b>IGNORÉ</b> (assume) — {@code ./gradlew test}
 *       reste vert sans Docker.</li>
 *   <li><b>true</b> (CI) : le test <b>ÉCHOUE</b>. Sinon des images qui ne construisent pas laisseraient
 *       tout le filet d'intégration s'ignorer en silence et le job passer au vert <em>sans rien avoir
 *       exécuté</em> — exactement le scénario qu'on veut interdire pour un gate de sécurité.</li>
 * </ul>
 * En CI, le job d'intégration construit les images, pose {@code SANDBOX_REQUIRED=true} puis exécute
 * ces tests (cf. .github/workflows).
 */
class ExecutionIntegrationTest {

    // En CI ce drapeau vaut true : une précondition manquante ÉCHOUE au lieu de s'ignorer, pour que
    // des images absentes ne puissent pas faire passer le gate de sécurité au vert « à vide ».
    private static final boolean SANDBOX_REQUIRED =
            Boolean.parseBoolean(System.getenv().getOrDefault("SANDBOX_REQUIRED", "false"));

    // Dossier vendor (bundles JSX/HTML). Absent → les questions JSX/HTML sont ignorées ici (testées
    // par les scripts E2E dans le conteneur). Les langages « appel de fonction » n'en ont pas besoin.
    private final CodeAssembler assembler =
            new CodeAssembler(System.getenv().getOrDefault("APP_VENDOR_DIR", "/nonexistent-vendor"));
    private static final RunnerExec RUNNER = new RunnerExec(
            new DockerSandbox("", 1536, 512, 2.0), "moodit-runner-",
            System.getenv().getOrDefault("MOODIT_RUNNER_TAG", "latest"));
    private final ExecutionService service = new ExecutionService(assembler, RUNNER);

    @BeforeEach
    void requireDocker() {
        gate(RUNNER.sandbox().available(), "Démon Docker injoignable");
    }

    /**
     * Précondition d'un test d'intégration. Si elle est satisfaite → on continue. Sinon : en CI
     * ({@code SANDBOX_REQUIRED=true}) on <b>échoue</b> (le filet ne doit pas s'ignorer en silence) ;
     * en local on <b>ignore</b> (assume) pour garder {@code ./gradlew test} vert sans Docker.
     */
    private static void gate(boolean available, String what) {
        if (available) {
            return;
        }
        if (SANDBOX_REQUIRED) {
            fail(what + " — indisponible alors que SANDBOX_REQUIRED=true : le filet d'intégration ne doit "
                    + "PAS s'ignorer en CI (sinon le gate de sécurité passe au vert sans rien exécuter).");
        }
        assumeTrue(false, what + " — test d'intégration ignoré (dev local, SANDBOX_REQUIRED absent)");
    }

    /** Vrai si la question réussit (tous ses harnais passent). */
    private boolean passes(String language, String code, String harness) {
        EvaluateRequest req = new EvaluateRequest(language, null, code,
                List.of(new TestCaseInput("t", harness, 1)));
        List<TestResult> res = service.evaluate(req);
        return !res.isEmpty() && res.stream().allMatch(TestResult::passed);
    }

    // ─────────────────────── Langages interprétés (RPC isolé) ───────────────────────
    // Pour chacun : (1) bonne réponse réussit, (2) réponse fausse échoue, (3) SÉCURITÉ : une réponse
    // fausse qui tente de lire sa source pour émettre le nonce ÉCHOUE (le serveur étudiant n'a pas de
    // nonce → résiduel fermé). Le harnais du prof est identique partout : « doubler(5) == 10 ».

    @Test
    void python_rpc_isolation() {
        requireRuntime("python");
        assertThat(passes("Python", "def doubler(n):\n    return n * 2", "return doubler(5) == 10")).isTrue();
        assertThat(passes("Python", "def doubler(n):\n    return 0", "return doubler(5) == 10")).isFalse();
        assertThat(passes("Python",
                "import re, sys\ndef doubler(n):\n    s = open(__file__).read()\n"
                        + "    m = re.search(r'MOODIT_OK_[0-9a-f]+', s)\n"
                        + "    sys.stderr.write(m.group() if m else 'X')\n    return 0",
                "return doubler(5) == 10")).isFalse();
        // Un print de premier niveau dont la sortie est du JSON valide ne fausse plus la correction.
        assertThat(passes("Python", "def doubler(n):\n    return n * 2\n\nprint(doubler(5))\nprint([1, 2])",
                "return doubler(5) == 10")).isTrue();
    }

    @Test
    void python_answering_rpc_early_fails() {
        requireRuntime("python");
        // DEVANCEMENT : le stdout du serveur étudiant EST le canal de réponse. En imprimant une
        // réponse conforme AVANT d'être appelé, le code noté la faisait consommer comme réponse
        // au premier appel — verdict vert sur une réponse fausse, sans jamais toucher au nonce.
        // Chaque appel porte donc un IDENTIFIANT imprévisible que la réponse doit renvoyer.
        assertThat(passes("Python",
                "import sys, json\n"
                        + "print(json.dumps({'ok': True, 'value': 10}), flush=True)\n"
                        + "def doubler(n):\n"
                        + "    print(json.dumps({'ok': True, 'value': 10}), flush=True)\n"
                        + "    return 0\n",
                "return doubler(5) == 10")).isFalse();
    }

    @Test
    void javascript_answering_rpc_early_fails() {
        requireRuntime("javascript");
        assertThat(passes("JavaScript",
                "console.log(JSON.stringify({ok: true, value: 10}));\n"
                        + "function doubler(n){ console.log(JSON.stringify({ok: true, value: 10}));"
                        + " return 0; }",
                "return doubler(5) === 10;")).isFalse();
    }

    @Test
    void javascript_rpc_isolation() {
        requireRuntime("javascript");
        assertThat(passes("JavaScript", "function doubler(n){ return n * 2; }", "return doubler(5) === 10;")).isTrue();
        assertThat(passes("JavaScript", "function doubler(n){ return 0; }", "return doubler(5) === 10;")).isFalse();
        assertThat(passes("JavaScript",
                "const fs = require('fs');\nfunction doubler(n){"
                        + " try{ const m = fs.readFileSync(__filename,'utf8').match(/MOODIT_OK_[0-9a-f]+/);"
                        + " if(m) process.stderr.write(m[0]); }catch(e){} return 0; }",
                "return doubler(5) === 10;")).isFalse();
    }

    @Test
    void typescript_rpc_isolation() {
        requireRuntime("typescript");
        assertThat(passes("TypeScript",
                "function doubler(n: number): number { return n * 2; }", "return doubler(5) === 10;")).isTrue();
        assertThat(passes("TypeScript",
                "function doubler(n: number): number { return 0; }", "return doubler(5) === 10;")).isFalse();
    }

    @Test
    void php_rpc_isolation() {
        requireRuntime("php");
        assertThat(passes("PHP", "<?php\nfunction doubler($n){ return $n * 2; }", "return doubler(5) === 10;")).isTrue();
        assertThat(passes("PHP", "<?php\nfunction doubler($n){ return 0; }", "return doubler(5) === 10;")).isFalse();
        assertThat(passes("PHP",
                "<?php\nfunction doubler($n){ $s = file_get_contents(__FILE__);"
                        + " if (preg_match('/MOODIT_OK_[0-9a-f]+/', $s, $m)) fwrite(STDERR, $m[0]); return 0; }",
                "return doubler(5) === 10;")).isFalse();
        // Un echo de premier niveau (avec ou sans retour à la ligne) ne fausse plus la correction.
        assertThat(passes("PHP", "<?php\nfunction doubler($n){ return $n * 2; }\necho 5;",
                "return doubler(5) === 10;")).isTrue();
        assertThat(passes("PHP", "<?php\nfunction doubler($n){ return $n * 2; }\necho \"[1,2]\\n\";",
                "return doubler(5) === 10;")).isTrue();
    }

    @Test
    void bash_rpc_isolation() {
        requireRuntime("bash");
        assertThat(passes("Bash", "doubler() { echo $(( $1 * 2 )); }", "[ \"$(doubler 5)\" = \"10\" ]")).isTrue();
        assertThat(passes("Bash", "doubler() { echo 0; }", "[ \"$(doubler 5)\" = \"10\" ]")).isFalse();
        // Valeur MULTI-LIGNE : l'ancien protocole ne gardait que la premiere ligne de la
        // reponse (le noteur filtre « id|... » ligne a ligne), et une reponse juste etait
        // notee fausse. La valeur voyage desormais en hex sur une ligne, decodee cote noteur.
        assertThat(passes("Bash", "lister() { printf 'a\\nb'; }",
                "[ \"$(lister)\" = \"$(printf 'a\\nb')\" ]")).isTrue();
        assertThat(passes("Bash", "lister() { printf 'a'; }",
                "[ \"$(lister)\" = \"$(printf 'a\\nb')\" ]")).isFalse();
        assertThat(passes("Bash",
                "doubler() { grep -oE 'MOODIT_OK_[0-9a-f]+' grader.sh 2>/dev/null >&2; echo 0; }",
                "[ \"$(doubler 5)\" = \"10\" ]")).isFalse();
        // CONTREFAÇON de la ligne de réponse : le code de premier niveau consomme stdin pour y
        // apprendre l'identifiant de l'appel, puis publie lui-même « <id>|10 ». Il ne le voit
        // plus (lu avant son chargement) et sa sortie est capturée, pas publiée.
        assertThat(passes("Bash",
                "__vol=$(cat); printf '%s|10\\n' \"${__vol%% *}\"\n"
                        + "doubler() { echo 0; }",
                "[ \"$(doubler 5)\" = \"10\" ]")).isFalse();
    }

    @Test
    void bash_submission_cannot_read_the_nonce_through_the_grader_descriptor() {
        // Revue #246 : grader.sh était effacé, mais bash le garde ouvert (fd 255). Sous le même
        // UID, /proc/<pid>/fd/255 rouvrait le fichier supprimé, nonce compris ; le code soumis
        // le publiait ensuite par le stderr du noteur (/proc/<pid>/fd/2) ou en remplaçant
        // run.err, que root relisait par son chemin. Le noteur se vide désormais avant tout
        // appel, et les sorties capturées vivent dans un dossier de root.
        requireRuntime("bash");
        String forged = "doubler() {\n"
                + "  local n='' f p\n"
                + "  for f in /proc/[0-9]*/fd/255; do\n"
                + "    n=$(grep -aoE 'MOODIT_OK_[0-9a-f]+' \"$f\" 2>/dev/null | head -n 1)\n"
                + "    [ -n \"$n\" ] && break\n"
                + "  done\n"
                + "  for p in /proc/[0-9]*/fd/2; do printf '%s' \"$n\" > \"$p\" 2>/dev/null; done\n"
                + "  for p in /box/work/run.err /box/work/run.out; do\n"
                + "    rm -f \"$p\" 2>/dev/null; printf '%s' \"$n\" > \"$p\" 2>/dev/null\n"
                + "  done\n"
                + "  echo 0\n"
                + "}";
        assertThat(passes("Bash", forged, "[ \"$(doubler 5)\" = \"10\" ]")).isFalse();
    }

    /** Détail du premier verdict (diagnostic attendu d'un refus). */
    private String detail(String language, String code, String harness) {
        return service.evaluate(new EvaluateRequest(language, null, code,
                List.of(new TestCaseInput("t", harness, 1)))).get(0).detail();
    }

    @Test
    void python_submitted_builtin_name_cannot_forge_the_verdict() {
        // Revue #246 : un mandataire `bool` masquait la fonction intégrée dans le VERDICT du
        // noteur ; `abs` ou `len` la masquaient dans le harnais. Refus explicite, et le
        // verdict n'appelle plus que la vraie `bool`.
        requireRuntime("python");
        assertThat(passes("Python", "def bool(x):\n    return True\ndef doubler(n):\n    return 0",
                "return doubler(5) == 10")).isFalse();
        assertThat(passes("Python", "def abs(x):\n    return 0\ndef moitie(n):\n    return 0",
                "return abs(moitie(5) - 2.5) < 1e-9")).isFalse();
        assertThat(detail("Python", "def len(x):\n    return 3\ndef liste():\n    return []",
                "return len(liste()) == 3")).contains("réservé").contains("len");
        // Témoin : sans masquage, la même forme de harnais note normalement.
        assertThat(passes("Python", "def moitie(n):\n    return n / 2",
                "return abs(moitie(5) - 2.5) < 1e-9")).isTrue();
    }

    @Test
    void python_module_dropped_next_to_the_grader_cannot_forge_the_verdict() {
        // Revue #246 : le noteur tournait avec son dossier (inscriptible par le code soumis) en
        // tête de sys.path. Un harnais qui importe une bibliothèque faisait charger, DANS le
        // noteur, les modules que le code soumis y avait déposés — ils y lisaient le nonce.
        requireRuntime("python");
        String harness = "import numpy as np\nreturn bool(np.isclose(carre(3.0), 9.0))";
        String payload = "import sys\n"
                + "f = sys._getframe()\n"
                + "while f is not None:\n"
                + "    for c in f.f_code.co_consts:\n"
                + "        if isinstance(c, str) and c.startswith('MOODIT_OK_'):\n"
                + "            sys.stderr.write(c)\n"
                + "    f = f.f_back\n"
                + "raise ImportError('x')\n";
        String forged = "import sys\n"
                + "__p = " + pythonLiteral(payload) + "\n"
                + "for __n in ('numpy', 'pickle', 'ast', 'platform', 'statistics', 'decimal',\n"
                + "            'datetime', 'copy', 'threading', 'inspect', 'textwrap'):\n"
                + "    if __n not in sys.modules:\n"
                + "        open(__n + '.py', 'w').write(__p)\n"
                + "def carre(x):\n    return 0\n";
        assertThat(passes("Python", forged, harness)).isFalse();
        // Témoins : le même harnais note normalement une réponse juste, et refuse une fausse.
        assertThat(passes("Python", "def carre(x):\n    return x * x", harness)).isTrue();
        assertThat(passes("Python", "def carre(x):\n    return 0", harness)).isFalse();
    }

    /** Littéral chaîne Python entre guillemets simples (texte ASCII de test). */
    private static String pythonLiteral(String text) {
        return "'" + text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'";
    }

    @Test
    void javascript_submitted_global_name_cannot_forge_the_verdict() {
        requireRuntime("javascript");
        assertThat(passes("JavaScript", "function Number(x){ return 3; }\nfunction f(){ return 0; }",
                "return Number(f()) === 3;")).isFalse();
        assertThat(detail("JavaScript", "function parseInt(x){ return 3; }\nfunction f(){ return '0'; }",
                "return parseInt(f()) === 3;")).contains("réservé").contains("parseInt");
        assertThat(passes("JavaScript", "function f(){ return '3'; }",
                "return Number(f()) === 3;")).isTrue();
    }

    @Test
    void bash_submitted_command_name_cannot_forge_the_verdict() {
        // Revue #246 : `test() { :; }` remplaçait le `test` du harnais (forme du gabarit), de
        // même pour un programme du PATH (`expr`).
        requireRuntime("bash");
        assertThat(passes("Bash", "test() { :; }\nsolution() { echo 0; }",
                "test \"$(solution)\" = \"9\"")).isFalse();
        assertThat(passes("Bash", "expr() { echo 1; }\nsolution() { echo 0; }",
                "[ \"$(expr \"$(solution)\" = 9)\" = 1 ]")).isFalse();
        assertThat(detail("Bash", "test() { :; }\nsolution() { echo 0; }",
                "test \"$(solution)\" = \"9\"")).contains("réservé").contains("test");
    }

    @Test
    void helper_named_like_a_builtin_is_graded_when_the_harness_does_not_use_it() {
        // Revue #246 : une fonction d'aide au nom d'une intégrée, que le harnais n'appelle
        // pas, était refusée (« Nom réservé ») — 0 sur une réponse juste. Elle est notée
        // normalement, et une réponse fausse reste fausse.
        requireRuntime("python");
        String py = "def max(a, b):\n    return a if a > b else b\n"
                + "def plus_grand(a, b, c):\n    return max(a, max(b, c))";
        assertThat(passes("Python", py, "return plus_grand(1, 9, 3) == 9")).isTrue();
        assertThat(passes("Python", py.replace("a > b", "a < b"),
                "return plus_grand(1, 9, 3) == 9")).isFalse();
        requireRuntime("javascript");
        assertThat(passes("JavaScript",
                "function parseInt(s){ return Number(s); }\nfunction double(s){ return parseInt(s) * 2; }",
                "return double('4') === 8;")).isTrue();
        requireRuntime("bash");
        assertThat(passes("Bash", "test() { echo \"$1\"; }\ncarre() { test $(( $1 * $1 )); }",
                "[ \"$(carre 3)\" = 9 ]")).isTrue();
    }

    @Test
    void bash_proxy_returns_the_status_of_the_real_call() {
        // Le mandataire renvoyait toujours 0 : `est_pair 3` était vrai pour toute réponse, et
        // une réponse juste qui renvoie 1 pour un impair était notée fausse.
        requireRuntime("bash");
        String h = "est_pair 4 && ! est_pair 3";
        assertThat(passes("Bash", "est_pair() { [ $(( $1 % 2 )) -eq 0 ]; }", h)).isTrue();
        assertThat(passes("Bash", "est_pair() { return 0; }", h)).isFalse();
        assertThat(passes("Bash", "est_pair() { return 1; }", "est_pair 4")).isFalse();
    }

    // Balayage systématique des collisions de noms (#246), côté SERVEUR : le code soumis partage
    // le module du serveur généré, qui ne doit dépendre d'aucun nom que l'étudiant peut porter.

    @Test
    void python_helper_named_like_a_builtin_the_server_uses_is_graded() {
        requireRuntime("python");
        String py = "def print(x):\n    return None\ndef len(x):\n    return 99\n"
                + "def str(x):\n    return 'z'\ndef globals():\n    return {}\n"
                + "class R:\n    def __init__(self, a):\n        self.a = a\n"
                + "    def aire(self):\n        print(self.a)\n        return self.a\n"
                + "def doubler(n):\n    return n * 2\n";
        String h = "return doubler(5) == 10 and R(3).aire() == 3 and R(4).aire() == 4";
        assertThat(passes("Python", py, h)).isTrue();
        assertThat(passes("Python", py.replace("n * 2", "0"), h)).isFalse();
    }

    @Test
    void javascript_function_named_like_a_server_local_is_graded() {
        // `i`, `m`, `r`, `d`, `line`, `buf`… étaient les locales de la boucle du serveur, où un
        // `eval` résolvait le nom demandé : il rendait la variable du serveur.
        String h = "return i(1) === 2 && m(1) === 3 && r(1) === 4 && line(7) === 7"
                + " && new objs(2).d() === 2;";
        for (String language : List.of("JavaScript", "TypeScript")) {
            requireRuntime(language.toLowerCase());
            String js = "function i(x){ return x + 1; }\nfunction m(x){ return x + 2; }\n"
                    + "const r = (x) => x + 3;\nfunction line(x){ return x; }\n"
                    + "class objs { constructor(a){ this.a = a; } d(){ return this.a; } }\n";
            assertThat(passes(language, js, h)).as(language).isTrue();
            assertThat(passes(language, js.replace("x + 1", "0"), h)).as(language).isFalse();
        }
    }

    @Test
    void javascript_helper_named_like_a_global_the_server_uses_is_graded() {
        // Fonction hissée (`function JSON`) ou zone morte (`const process`) : les deux
        // remplaçaient l'objet global dans le module du serveur.
        requireRuntime("javascript");
        String js = "function JSON(x){ return x; }\nfunction String(x){ return 'z'; }\n"
                + "const process = 3;\nconst console = { log(){} };\n"
                + "function doubler(n){ return n * 2 + process - 3; }\n";
        assertThat(passes("JavaScript", js, "return doubler(5) === 10;")).isTrue();
        assertThat(passes("JavaScript", js.replace("n * 2", "0"), "return doubler(5) === 10;"))
                .isFalse();
    }

    @Test
    void typescript_exported_function_and_class_are_graded() {
        requireRuntime("typescript");
        String ts = "export function doubler(n: number): number { return n * 2; }\n"
                + "export class Rect { a: number; constructor(a: number){ this.a = a; }"
                + " aire(): number { return this.a; } }\n";
        String h = "return doubler(2) === 4 && new Rect(3).aire() === 3;";
        assertThat(passes("TypeScript", ts, h)).isTrue();
        assertThat(passes("TypeScript", ts.replace("n * 2", "0"), h)).isFalse();
    }

    @Test
    void typescript_export_forms_are_graded() {
        // `export const f = <appel>` : tsc n'émet que `exports.f = …`, sans liaison locale. Le
        // serveur résolvait le nom par `eval` seulement — « f is not defined », réponse juste
        // notée fausse. Les autres formes d'export passent par la liaison locale.
        requireRuntime("typescript");
        String ts = "const memo = (g: any): any => g;\n"
                + "export const doubler = memo((n: number): number => n * 2);\n"
                + "export const tripler = (n: number): number => n * 3;\n"
                + "export default class Rect { a: number; constructor(a: number){ this.a = a; }"
                + " aire(): number { return this.a; } }\n";
        String h = "return doubler(2) === 4 && tripler(2) === 6 && new Rect(3).aire() === 3;";
        assertThat(passes("TypeScript", ts, h)).isTrue();
        assertThat(passes("TypeScript", ts.replace("n * 2", "0"), h)).isFalse();
        assertThat(passes("TypeScript", ts.replace("n * 3", "0"), h)).isFalse();
        assertThat(passes("TypeScript", ts.replace("return this.a;", "return 0;"), h)).isFalse();
        String fn = "export default function doubler(n: number): number { return n * 2; }\n";
        assertThat(passes("TypeScript", fn, "return doubler(5) === 10;")).isTrue();
        assertThat(passes("TypeScript", fn.replace("n * 2", "0"), "return doubler(5) === 10;"))
                .isFalse();
    }

    @Test
    void javascript_exported_symbols_are_graded() {
        // Un fichier JavaScript qui porte `export` est chargé par Node comme module ES : le
        // serveur n'y dispose ni de `require` ni d'`exports`.
        requireRuntime("javascript");
        String js = "const memo = (g) => g;\n"
                + "export function doubler(n){ return n * 2; }\n"
                + "export const tripler = memo((n) => n * 3);\n"
                + "export class Rect { constructor(a){ this.a = a; } aire(){ return this.a; } }\n";
        String h = "return doubler(2) === 4 && tripler(2) === 6 && new Rect(3).aire() === 3;";
        assertThat(passes("JavaScript", js, h)).isTrue();
        assertThat(passes("JavaScript", js.replace("n * 2", "0"), h)).isFalse();
        assertThat(passes("JavaScript", js.replace("n * 3", "0"), h)).isFalse();
        assertThat(passes("JavaScript", js.replace("return this.a;", "return 0;"), h)).isFalse();
    }

    @Test
    void unresolvable_symbol_reports_its_own_error_not_the_fallback_s() {
        // `cache` est en colonne 0, donc mandaté, mais déclaré dans un bloc : le serveur ne peut
        // pas le résoudre. Le repli sur `exports` ne doit pas changer l'erreur rendue : en module
        // ES (`export` en JavaScript) `exports` n'existe pas, et son ReferenceError remplaçait
        // celui du nom demandé ; en CommonJS (TypeScript) `exports.cache` est absent.
        String h = "try { cache(1); return false; }"
                + " catch (e) { return e.message === 'cache is not defined' && doubler(2) === 4; }";
        for (String language : List.of("JavaScript", "TypeScript")) {
            requireRuntime(language.toLowerCase());
            String code = "export function doubler(n){ return n * 2; }\n{\nconst cache = (n) => n;\n}\n";
            assertThat(passes(language, code, h)).as(language).isTrue();
            assertThat(passes(language, code.replace("n * 2", "0"), h)).as(language).isFalse();
        }
    }

    // Objets (proxys de classe) : Python et JS, harnais objet inchangé.
    @Test
    void class_proxies_work() {
        requireRuntime("python");
        assertThat(passes("Python",
                "class Rectangle:\n    def __init__(self, l, h):\n        self.l = l; self.h = h\n"
                        + "    def aire(self):\n        return self.l * self.h",
                "return Rectangle(3, 4).aire() == 12")).isTrue();
        assertThat(passes("JavaScript",
                "class Rectangle { constructor(l, h){ this.l = l; this.h = h; } aire(){ return this.l * this.h; } }",
                "return new Rectangle(3, 4).aire() === 12;")).isTrue();
    }

    // ─────────────────────── JSX / TSX (proxy DOM isolé) ───────────────────────
    // Requiert le bundle react-runtime.js (APP_VENDOR_DIR) ; ignoré sinon. Couvre le rendu STATIQUE
    // (html), l'INTERACTIF (mount/click via proxy DOM) et la SÉCURITÉ (le composant ne peut plus
    // lire le nonce — process.mainModule.require était le vecteur, désormais fermé par l'isolation).

    @Test
    void jsx_answering_rpc_early_fails() {
        requireRuntime("javascript");
        gate(vendorAvailable(), "Bundle react-runtime.js absent (APP_VENDOR_DIR)");
        // Jumeau du test JS : une ligne conforme ecrite D'AVANCE sur stdout (au chargement
        // du module) etait consommee comme reponse au premier appel. L'identifiant par
        // appel, desormais exige dans la reponse, la fait ignorer.
        assertThat(passes("JSX",
                "process.stdout.write(JSON.stringify({ok:true, value:'<h1>Bonjour</h1>'})"
                        + " + String.fromCharCode(10));"
                        + "function Composant(){ return React.createElement('div'); }",
                "return html.includes('<h1>Bonjour</h1>');")).isFalse();
    }

    @Test
    void jsx_honest_console_log_does_not_cost_the_grade() {
        requireRuntime("javascript");
        gate(vendorAvailable(), "Bundle react-runtime.js absent (APP_VENDOR_DIR)");
        // Un console.log de debogage au chargement ET pendant le rendu : reflexe honnete.
        // Il polluait la premiere ligne lue par le noteur (JSON casse -> html undefined),
        // et une reponse JUSTE etait notee 0 sur tentative unique — la classe de defaut
        // que cette PR ferme partout ailleurs.
        assertThat(passes("JSX",
                "console.log('charge');\n"
                        + "function Composant(){ console.log('rendu');"
                        + " return React.createElement('h1', null, 'Bonjour'); }",
                "return html.includes('<h1>Bonjour</h1>');")).isTrue();
    }

    @Test
    void jsx_static_render_isolation() {
        requireRuntime("javascript");
        gate(vendorAvailable(), "Bundle react-runtime.js absent (APP_VENDOR_DIR)");
        String h = "return html.includes('<h1>Bonjour</h1>');";
        assertThat(passes("JSX", "function Composant(){ return React.createElement('h1', null, 'Bonjour'); }", h)).isTrue();
        assertThat(passes("JSX", "function Composant(){ return React.createElement('div'); }", h)).isFalse();
        // SÉCURITÉ : composant FAUX qui tente d'extraire le nonce du noteur → échec (isolé).
        assertThat(passes("JSX",
                "function Composant(){ try{ const fs = process.mainModule.require('fs');"
                        + " const m = fs.readFileSync('main.js','utf8').match(/MOODIT_OK_[0-9a-f]+/);"
                        + " if(m) process.stderr.write(m[0]); }catch(e){} return React.createElement('div'); }",
                h)).isFalse();
    }

    @Test
    void jsx_interactive_via_dom_proxy() {
        requireRuntime("javascript");
        gate(vendorAvailable(), "Bundle react-runtime.js absent (APP_VENDOR_DIR) — JSX interactif");
        String harness = "const c = mount(Composant);\n"
                + "const btn = c.querySelector('button');\n"
                + "if (btn.textContent.trim() !== '0') return false;\n"
                + "click(btn);\n"
                + "return btn.textContent.trim() === '1';";
        assertThat(passes("JSX",
                "function Composant(){ const [n, setN] = React.useState(0);"
                        + " return React.createElement('button', { onClick: () => setN(n + 1) }, n); }",
                harness)).isTrue();
    }

    @Test
    void tsx_static_render_isolation() {
        requireRuntime("javascript");
        gate(vendorAvailable(), "Bundle react-runtime.js absent (APP_VENDOR_DIR) — TSX");
        String h = "return html.includes('<span>5</span>');";
        assertThat(passes("TSX",
                "function Composant(): JSX.Element { return React.createElement('span', null, 2 + 3); }", h)).isTrue();
        assertThat(passes("TSX",
                "function Composant(): JSX.Element { return React.createElement('span', null, 99); }", h)).isFalse();
    }

    // Les langages COMPILÉS ne passent plus par Piston (#116) : leur filet d'intégration vit dans
    // RpcGradingIntegrationTest (notation non falsifiable) et RunnerSandboxIntegrationTest.

    /** L'image runner du runtime est-elle construite ? Même politique que {@link #gate}. */
    private static void requireRuntime(String runtime) {
        String image = RUNNER.imageFor(runtime);
        gate(RUNNER.sandbox().imagePresent(image), "Image runner absente : " + image);
    }

    // ─────────────────────── SQL (isolation 2 phases) : non-régression ───────────────────────
    @Test
    void sql_isolation_still_works() {
        requireRuntime("sqlite3");
        String roHarness = "CREATE TABLE t(n INTEGER);\nINSERT INTO t VALUES (1),(2),(3);\n"
                + "SELECT (SELECT count(*) FROM solution1) = 3;";
        assertThat(passes("SQL", "SELECT n FROM t", roHarness)).isTrue();
        assertThat(passes("SQL", "SELECT n FROM t WHERE n > 1", roHarness)).isFalse();
    }

    @Test
    void sql_go_line_and_file_reads_cannot_forge_the_verdict() {
        // Revue #246 : une ligne « go » faisait sortir la réponse de son CREATE VIEW, et
        // readfile('main.sql') (ou la table virtuelle fsdir) y lisait les sentinelles au nonce
        // pour imprimer un faux bloc de verdict avant le vrai.
        requireRuntime("sqlite3");
        String roHarness = "CREATE TABLE t(n INTEGER);\nINSERT INTO t VALUES (1),(2),(3);\n"
                + "SELECT (SELECT count(*) FROM solution1) = 3;";
        // Sentinelle = « MOODIT_OK_ » + 48 hex + « _VERDICT_START » (72 caractères), cherchée
        // par sa fin, écrite en deux morceaux pour ne pas trouver ce texte-ci dans main.sql.
        String sentinel = "substr(src, instr(src, '_VERDICT_' || 'START') - 58, 72)";
        String forge = "SELECT n FROM t WHERE n > 1\ngo\n"
                + "SELECT " + sentinel + " || char(10) || '1' || char(10) || replace(" + sentinel
                + ", 'START', 'END') FROM (SELECT CAST(data AS TEXT) AS src FROM fsdir('main.sql'))";
        assertThat(passes("SQL", forge, roHarness)).isFalse();
        // Mode modification : le code soumis tourne tel quel en phase 1. Il ne doit pas non plus
        // pouvoir lire son programme, qui porte les sentinelles du dump : le harnais réussit
        // seulement si le texte lu les contient.
        String harness = "CREATE TABLE t(v TEXT);\n-- @student\n"
                + "SELECT (SELECT count(*) FROM t WHERE instr(v, '_DUMP_' || 'START') > 0) = 1;";
        assertThat(passes("SQL", "INSERT INTO t SELECT CAST(data AS TEXT) FROM fsdir('main.sql');",
                harness)).isFalse();
    }

    // ─────────────────────── Limites du bac à sable (#24) ───────────────────────

    @Test
    void sql_etat_de_plus_de_100_ko_recu_complet() {
        // Phase 1 : l'étudiant remplit la table de 2 000 lignes de 50 caractères ; le dump renvoyé
        // par Piston dépasse 100 Ko. Avec la limite de sortie par défaut de Piston (1 024 caractères),
        // il serait tronqué et la phase 2 ne retrouverait pas toutes les lignes.
        requireRuntime("sqlite3");
        String harness = "CREATE TABLE t(v TEXT);\n-- @student\n"
                + "SELECT (SELECT count(*) FROM t) = 2000 AND (SELECT sum(length(v)) FROM t) = 100000;";
        String student = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) "
                + "INSERT INTO t SELECT printf('%050d', i) FROM n;";
        assertThat(passes("SQL", student, harness)).isTrue();
    }

    @Test
    void boucle_d_allocation_tuee_par_la_limite_memoire() {
        // La limite mémoire du conteneur runner (app.sandbox.memory-mb) tue la boucle d'allocation :
        // le processus meurt par SIGNAL (OOM du cgroup → SIGKILL), jamais en « réussite ».
        requireRuntime("python");
        RunnerExec.Stage run = RUNNER.execute("python", List.of(new RunnerExec.File("main.py",
                "a = []\nwhile True:\n    a.append(bytearray(10 * 1024 * 1024))\n"))).run();
        assertThat("SIGKILL".equals(run.signal()) || (run.code() != null && run.code() != 0)).isTrue();
    }

    @Test
    void run_java_floor_covers_compilation_and_cold_jvm() {
        // Mode fichier-source (JEP 330) : la compilation vit dans la fenêtre de run — le
        // plancher du superviseur (10 s) doit absorber javac en-processus + la JVM froide,
        // sinon un « Exécuter » correct était « Interrompu » par intermittence (défaut 3 s).
        requireRuntime("java");
        RunnerExec.Stage run = RUNNER.execute("java", List.of(new RunnerExec.File("Main.java",
                "public class Main { public static void main(String[] a) {"
                        + " System.out.println(\"bonjour java\"); } }"))).run();
        assertThat(run.code()).isZero();
        assertThat(run.stdout()).contains("bonjour java");
    }

    @Test
    void run_go_compilation_separate_from_run_window() {
        requireRuntime("go");
        RunnerExec.Result res = RUNNER.execute("go", List.of(new RunnerExec.File("main.go",
                "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"bonjour go\") }\n")));
        // `go build` : étape de compilation séparée (budget dédié), le run n'exécute que ./prog.
        assertThat(res.compile()).isNotNull();
        assertThat(res.run().code()).isZero();
        assertThat(res.run().stdout()).contains("bonjour go");
    }

    /** Le bundle react-runtime.js est-il présent (nécessaire pour assembler JSX/TSX) ? */
    private static boolean vendorAvailable() {
        String dir = System.getenv().getOrDefault("APP_VENDOR_DIR", "/nonexistent-vendor");
        return java.nio.file.Files.isReadable(java.nio.file.Path.of(dir, "react-runtime.js"));
    }

}
