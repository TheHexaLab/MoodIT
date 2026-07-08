package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.HttpURLConnection;
import java.net.URI;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Tests d'INTÉGRATION comportementaux : exercent le VRAI code Java (assemblage + verdict) contre un
 * VRAI Piston. Contrairement aux tests unitaires (qui ne vérifient que la STRUCTURE des chaînes
 * générées), ceux-ci prouvent que les programmes assemblés s'exécutent et notent correctement —
 * notamment que l'ISOLATION RPC des langages interprétés ferme le résiduel (une réponse fausse qui
 * tente d'extraire le nonce ÉCHOUE).
 *
 * <p>Requiert un Piston joignable via {@code PISTON_URL} (défaut {@code http://localhost:2000}).
 * Le comportement quand une précondition manque (Piston injoignable, bundle vendor absent) dépend de
 * {@code PISTON_REQUIRED} :
 * <ul>
 *   <li><b>absent / false</b> (dev local) : le test est <b>IGNORÉ</b> (assume) — {@code ./gradlew test}
 *       reste vert sans Piston.</li>
 *   <li><b>true</b> (CI) : le test <b>ÉCHOUE</b>. Sinon un Piston qui ne démarre pas laisserait tout le
 *       filet d'intégration s'ignorer en silence et le job passer au vert <em>sans rien avoir exécuté</em>
 *       — exactement le scénario qu'on veut interdire pour un gate de sécurité.</li>
 * </ul>
 * En CI, le job d'intégration démarre Piston, pose {@code PISTON_REQUIRED=true} puis exécute ces tests
 * (cf. .github/workflows).
 */
class ExecutionIntegrationTest {

    private static final String PISTON = System.getenv().getOrDefault("PISTON_URL", "http://localhost:2000");

    // En CI ce drapeau vaut true : une précondition manquante ÉCHOUE au lieu de s'ignorer, pour qu'un
    // Piston/bundle absent ne puisse pas faire passer le gate de sécurité au vert « à vide ».
    private static final boolean PISTON_REQUIRED =
            Boolean.parseBoolean(System.getenv().getOrDefault("PISTON_REQUIRED", "false"));

    // Dossier vendor (bundles JSX/HTML). Absent → les questions JSX/HTML sont ignorées ici (testées
    // par les scripts E2E dans le conteneur). Les langages « appel de fonction » n'en ont pas besoin.
    private final CodeAssembler assembler =
            new CodeAssembler(System.getenv().getOrDefault("APP_VENDOR_DIR", "/nonexistent-vendor"));
    private final PistonClient piston = new PistonClient(PISTON, 3000, 10000, 20000);
    private final ExecutionService service = new ExecutionService(assembler, piston);

    @BeforeEach
    void requirePiston() {
        gate(reachable(PISTON), "Piston non joignable (" + PISTON + ")");
    }

    /**
     * Précondition d'un test d'intégration. Si elle est satisfaite → on continue. Sinon : en CI
     * ({@code PISTON_REQUIRED=true}) on <b>échoue</b> (le filet ne doit pas s'ignorer en silence) ;
     * en local on <b>ignore</b> (assume) pour garder {@code ./gradlew test} vert sans Piston.
     */
    private static void gate(boolean available, String what) {
        if (available) {
            return;
        }
        if (PISTON_REQUIRED) {
            fail(what + " — indisponible alors que PISTON_REQUIRED=true : le filet d'intégration ne doit "
                    + "PAS s'ignorer en CI (sinon le gate de sécurité passe au vert sans rien exécuter).");
        }
        assumeTrue(false, what + " — test d'intégration ignoré (dev local, PISTON_REQUIRED absent)");
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
        assertThat(passes("Python", "def doubler(n):\n    return n * 2", "return doubler(5) == 10")).isTrue();
        assertThat(passes("Python", "def doubler(n):\n    return 0", "return doubler(5) == 10")).isFalse();
        assertThat(passes("Python",
                "import re, sys\ndef doubler(n):\n    s = open(__file__).read()\n"
                        + "    m = re.search(r'MOODIT_OK_[0-9a-f]+', s)\n"
                        + "    sys.stderr.write(m.group() if m else 'X')\n    return 0",
                "return doubler(5) == 10")).isFalse();
    }

    @Test
    void javascript_rpc_isolation() {
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
        assertThat(passes("TypeScript",
                "function doubler(n: number): number { return n * 2; }", "return doubler(5) === 10;")).isTrue();
        assertThat(passes("TypeScript",
                "function doubler(n: number): number { return 0; }", "return doubler(5) === 10;")).isFalse();
    }

    @Test
    void php_rpc_isolation() {
        assertThat(passes("PHP", "<?php\nfunction doubler($n){ return $n * 2; }", "return doubler(5) === 10;")).isTrue();
        assertThat(passes("PHP", "<?php\nfunction doubler($n){ return 0; }", "return doubler(5) === 10;")).isFalse();
        assertThat(passes("PHP",
                "<?php\nfunction doubler($n){ $s = file_get_contents(__FILE__);"
                        + " if (preg_match('/MOODIT_OK_[0-9a-f]+/', $s, $m)) fwrite(STDERR, $m[0]); return 0; }",
                "return doubler(5) === 10;")).isFalse();
    }

    @Test
    void bash_rpc_isolation() {
        assertThat(passes("Bash", "doubler() { echo $(( $1 * 2 )); }", "[ \"$(doubler 5)\" = \"10\" ]")).isTrue();
        assertThat(passes("Bash", "doubler() { echo 0; }", "[ \"$(doubler 5)\" = \"10\" ]")).isFalse();
        assertThat(passes("Bash",
                "doubler() { grep -oE 'MOODIT_OK_[0-9a-f]+' grader.sh 2>/dev/null >&2; echo 0; }",
                "[ \"$(doubler 5)\" = \"10\" ]")).isFalse();
    }

    // Objets (proxys de classe) : Python et JS, harnais objet inchangé.
    @Test
    void class_proxies_work() {
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
    void jsx_static_render_isolation() {
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
        gate(vendorAvailable(), "Bundle react-runtime.js absent (APP_VENDOR_DIR) — TSX");
        String h = "return html.includes('<span>5</span>');";
        assertThat(passes("TSX",
                "function Composant(): JSX.Element { return React.createElement('span', null, 2 + 3); }", h)).isTrue();
        assertThat(passes("TSX",
                "function Composant(): JSX.Element { return React.createElement('span', null, 99); }", h)).isFalse();
    }

    // ─────────────────────── Compilés (nonce, déjà sûrs) : non-régression ───────────────────────
    @Test
    void compiled_nonce_still_works() {
        assertThat(passes("C", "int doubler(int n){ return n * 2; }", "return doubler(5) == 10;")).isTrue();
        assertThat(passes("C", "int doubler(int n){ return 0; }", "return doubler(5) == 10;")).isFalse();
        // ANTI-TRICHE (RPC) : un exit(0) anticipé tue le serveur étudiant → l'appel proxifié échoue,
        // le harnais lève, aucun nonce émis → échec (le nonce vit dans le noteur, pas chez l'étudiant).
        assertThat(passes("Python", "import sys\nsys.exit(0)", "return doubler(5) == 10")).isFalse();
    }

    // ─────────────────────── SQL (isolation 2 phases) : non-régression ───────────────────────
    @Test
    void sql_isolation_still_works() {
        String roHarness = "CREATE TABLE t(n INTEGER);\nINSERT INTO t VALUES (1),(2),(3);\n"
                + "SELECT (SELECT count(*) FROM solution1) = 3;";
        assertThat(passes("SQL", "SELECT n FROM t", roHarness)).isTrue();
        assertThat(passes("SQL", "SELECT n FROM t WHERE n > 1", roHarness)).isFalse();
    }

    /** Le bundle react-runtime.js est-il présent (nécessaire pour assembler JSX/TSX) ? */
    private static boolean vendorAvailable() {
        String dir = System.getenv().getOrDefault("APP_VENDOR_DIR", "/nonexistent-vendor");
        return java.nio.file.Files.isReadable(java.nio.file.Path.of(dir, "react-runtime.js"));
    }

    /** Piston répond-il sur {@code /api/v2/runtimes} ? (2 s max) */
    private static boolean reachable(String baseUrl) {
        try {
            HttpURLConnection c = (HttpURLConnection) URI.create(baseUrl + "/api/v2/runtimes").toURL().openConnection();
            c.setConnectTimeout(2000);
            c.setReadTimeout(2000);
            c.setRequestMethod("GET");
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }
}
