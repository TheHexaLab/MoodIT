package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.StructuredCase;
import com.moodit.execution_service.dto.StructuredEvaluateRequest;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonClient;
import tools.jackson.databind.ObjectMapper;
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

    private static final ObjectMapper M = new ObjectMapper();

    /** Vrai si tous les CAS STRUCTURÉS passent (serveur qui évalue les expressions ; attendus dehors). */
    private boolean passesStructured(String language, String code, StructuredCase... cases) {
        List<TestResult> res = service.evaluateStructured(
                new StructuredEvaluateRequest(language, null, code, List.of(cases)));
        return !res.isEmpty() && res.stream().allMatch(TestResult::passed);
    }

    /** Cas structuré : une expression (renvoyant la valeur, convention du langage) + l'attendu (JSON). */
    private StructuredCase cas(String expr, String expectedJson) {
        return new StructuredCase("t", expr, M.readTree(expectedJson), "exact", 1);
    }

    // #116 — Cas structurés : l'expression (appel de fonction OU construction d'objet + méthode) tourne
    // dans le serveur ; l'ATTENDU est comparé par execution-service, jamais dans le sandbox. On prouve
    // pour chaque compilé : fonction OK, POO OK, mauvais attendu → échec, mauvaise réponse/exception → échec.

    @Test
    void go_structured_cases_keep_expected_out_of_sandbox() {
        requireRuntime("go");
        String code = "package main\nfunc doubler(n int) int { return n * 2 }\n"
                + "type Rectangle struct { largeur, hauteur int }\n"
                + "func (r Rectangle) aire() int { return r.largeur * r.hauteur }\nfunc main() {}";
        assertThat(passesStructured("Go", code,
                cas("return doubler(5)", "10"),
                cas("return Rectangle{largeur: 3, hauteur: 4}.aire()", "12"))).isTrue();
        assertThat(passesStructured("Go", code, cas("return doubler(5)", "11"))).isFalse();
        assertThat(passesStructured("Go", code.replace("n * 2", "0"), cas("return doubler(5)", "10"))).isFalse();
        // SÉCURITÉ : fouiller la source ne révèle pas l'attendu (10 n'est nulle part dans le sandbox).
        String triche = "package main\nimport (\n\t\"os\"\n\t\"regexp\"\n\t\"strconv\"\n)\n"
                + "func doubler(n int) int {\n"
                + "\tb, _ := os.ReadFile(\"main.go\")\n"
                + "\tm := regexp.MustCompile(`[0-9]+`).FindString(string(b))\n"
                + "\tv, _ := strconv.Atoi(m)\n\treturn v\n}\nfunc main() {}";
        assertThat(passesStructured("Go", triche, cas("return doubler(5)", "10"))).isFalse();
    }

    @Test
    void go_structured_stdout_is_isolated_from_the_verdict() {
        requireRuntime("go");
        // (a) Fonction CORRECTE qui imprime AUSSI sur stdout : l'impression est détournée vers stderr,
        // le vrai verdict (émis sur le stdout préservé) reste propre → notée juste.
        String noisy = "package main\nimport \"fmt\"\n"
                + "func doubler(n int) int { fmt.Println(\"1\"); fmt.Println(\"999\"); return n * 2 }\nfunc main() {}";
        assertThat(passesStructured("Go", noisy, cas("return doubler(5)", "10"))).isTrue();
        // (b) Fonction FAUSSE qui tente de forger une paire « 1\n10 » sur stdout : l'impression est
        // détournée et la vraie valeur (0) ne correspond pas → échec (pas de verdict falsifiable).
        String cheat = "package main\nimport \"fmt\"\n"
                + "func doubler(n int) int { fmt.Println(\"1\"); fmt.Println(\"10\"); return 0 }\nfunc main() {}";
        assertThat(passesStructured("Go", cheat, cas("return doubler(5)", "10"))).isFalse();
    }

    @Test
    void rust_structured_cases_keep_expected_out_of_sandbox() {
        requireRuntime("rust");
        String code = "fn doubler(n: i32) -> i32 { n * 2 }\n"
                + "struct Rectangle { largeur: i32, hauteur: i32 }\n"
                + "impl Rectangle { fn aire(&self) -> i32 { self.largeur * self.hauteur } }\nfn main() {}";
        assertThat(passesStructured("Rust", code,
                cas("doubler(5)", "10"),
                cas("Rectangle { largeur: 3, hauteur: 4 }.aire()", "12"))).isTrue();
        assertThat(passesStructured("Rust", code, cas("doubler(5)", "11"))).isFalse();
        assertThat(passesStructured("Rust", "fn doubler(_n: i32) -> i32 { panic!(\"x\") }\nfn main() {}",
                cas("doubler(5)", "10"))).isFalse();
    }

    @Test
    void c_structured_cases_keep_expected_out_of_sandbox() {
        requireRuntime("c");
        String code = "int doubler(int n){ return n * 2; }\nint main(void){ return 0; }";
        assertThat(passesStructured("C", code, cas("return doubler(5);", "10"))).isTrue();
        assertThat(passesStructured("C", code, cas("return doubler(5);", "11"))).isFalse();
        assertThat(passesStructured("C", code.replace("n * 2", "0"), cas("return doubler(5);", "10"))).isFalse();
    }

    @Test
    void cpp_structured_cases_keep_expected_out_of_sandbox() {
        requireRuntime("c++");
        String code = "struct Rectangle { int l, h; Rectangle(int a, int b): l(a), h(b) {} int aire(){ return l * h; } };\n"
                + "int doubler(int n){ return n * 2; }\nint boom(){ throw 1; }\nint main(){ return 0; }";
        assertThat(passesStructured("C++", code,
                cas("return doubler(5);", "10"),
                cas("return Rectangle(3, 4).aire();", "12"))).isTrue();
        assertThat(passesStructured("C++", code, cas("return doubler(5);", "11"))).isFalse();
        // exception étudiant → échec du cas (pas de faux positif).
        assertThat(passesStructured("C++", code, cas("return boom();", "10"))).isFalse();
    }

    @Test
    void csharp_structured_cases_keep_expected_out_of_sandbox() {
        requireRuntime("csharp");
        String code = "class Solution { public static int doubler(int n){ return n * 2; } }\n"
                + "class Rectangle { int l, h; public Rectangle(int a, int b){ l = a; h = b; } public int aire(){ return l * h; } }";
        assertThat(passesStructured("C#", code,
                cas("return Solution.doubler(5);", "10"),
                cas("return new Rectangle(3, 4).aire();", "12"))).isTrue();
        assertThat(passesStructured("C#", code, cas("return Solution.doubler(5);", "11"))).isFalse();
    }

    @Test
    void java_structured_cases_keep_expected_out_of_sandbox() {
        requireRuntime("java");
        String code = "public class Solution { public static int doubler(int n){ return n * 2; } }\n"
                + "class Rectangle { int l, h; Rectangle(int a, int b){ l = a; h = b; } int aire(){ return l * h; } }";
        assertThat(passesStructured("Java", code,
                cas("return Solution.doubler(5);", "10"),
                cas("return new Rectangle(3, 4).aire();", "12"))).isTrue();
        assertThat(passesStructured("Java", code, cas("return Solution.doubler(5);", "11"))).isFalse();
        assertThat(passesStructured("Java",
                "public class Solution { public static int doubler(int n){ throw new RuntimeException(); } }",
                cas("return Solution.doubler(5);", "10"))).isFalse();
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
        // Un print de premier niveau dont la sortie est du JSON valide ne fausse plus la correction.
        assertThat(passes("Python", "def doubler(n):\n    return n * 2\n\nprint(doubler(5))\nprint([1, 2])",
                "return doubler(5) == 10")).isTrue();
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
        // Un echo de premier niveau (avec ou sans retour à la ligne) ne fausse plus la correction.
        assertThat(passes("PHP", "<?php\nfunction doubler($n){ return $n * 2; }\necho 5;",
                "return doubler(5) === 10;")).isTrue();
        assertThat(passes("PHP", "<?php\nfunction doubler($n){ return $n * 2; }\necho \"[1,2]\\n\";",
                "return doubler(5) === 10;")).isTrue();
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

    // ─────────── Compilés (isolation RPC en deux processus : fork/re-exec, cf. #116) ───────────
    // Pour chacun : (1) bonne réponse réussit, (2) réponse fausse échoue, (3) exception/panic échoue,
    // (4) appel interne (le serveur appelle le vrai symbole, pas le stub), (5) SÉCURITÉ : le code
    //     étudiant (qui COMPILE et s'exécute vraiment, dans le child) fouille son processus ET celui du
    //     parent (environ/cmdline/mem) sans jamais trouver le nonce → verdict faux pour la bonne raison.

    // Scan manuel (sans <string.h>, non inclus par l'assembleur → un étudiant qui redéfinit strlen
    // compile) : si « MOOD » (début de MOODIT_OK_) apparaît dans un fichier /proc, on le crache.
    private static final String C_SCAN =
            "int __scan(const char* path){ FILE* f=fopen(path,\"r\"); if(!f) return 0;\n"
            + "  char b[8192]; long l=fread(b,1,sizeof(b),f); fclose(f);\n"
            + "  for(long i=0;i+4<=l;i++) if(b[i]=='M'&&b[i+1]=='O'&&b[i+2]=='O'&&b[i+3]=='D'){ fwrite(b+i,1,(l-i>40?40:l-i),stderr); return 1; }\n"
            + "  return 0; }\n";

    @Test
    void c_isolation_rpc_deux_processus() {
        requireRuntime("c");
        assertThat(passes("C", "int doubler(int n){ return n * 2; }", "return doubler(5) == 10;")).isTrue();
        assertThat(passes("C", "int doubler(int n){ return 0; }", "return doubler(5) == 10;")).isFalse();
        // Appel interne : la fonction exposée délègue à un helper étudiant (appelé réellement côté serveur).
        assertThat(passes("C", "int h(int n){ return n*2; } int d(int n){ return h(n); }",
                "return d(5) == 10;")).isTrue();
        // RÉGRESSION P2 : un étudiant qui redéfinit une fonction de <string.h> compile (on ne l'inclut
        // plus) — avant, les includes après le code donnaient « conflicting types ».
        assertThat(passes("C", "int strlen2(char* s){ return 0; } int doubler(int n){ return n*2; }",
                "return doubler(5) == 10;")).isTrue();

        // SÉCURITÉ (le code étudiant COMPILE et s'exécute dans le CHILD, sans le nonce) : fouiller son
        // processus et celui du parent (environ + mémoire) ne révèle rien ; verdict faux.
        assertThat(passes("C",
                C_SCAN
                + "int doubler(int n){ char p[64]; long pp=getppid();\n"
                + "  __scan(\"/proc/self/environ\"); __scan(\"/proc/self/cmdline\");\n"
                + "  snprintf(p,sizeof(p),\"/proc/%ld/environ\",pp); __scan(p);\n"
                + "  snprintf(p,sizeof(p),\"/proc/%ld/mem\",pp); __scan(p);\n"
                + "  return 0; }",
                "return doubler(5) == 10;")).isFalse();
    }

    @Test
    void cpp_isolation_rpc_deux_processus() {
        requireRuntime("c++");
        String good = "int doubler(int n){ return n * 2; }\nint main(){ return 0; }";
        assertThat(passes("C++", good, "return doubler(5) == 10;")).isTrue();
        assertThat(passes("C++", good.replace("n * 2", "0"), "return doubler(5) == 10;")).isFalse();
        // Une exception côté étudiant (attrapée dans le serveur) vaut échec.
        assertThat(passes("C++", "int doubler(int n){ throw 1; }\nint main(){ return 0; }",
                "return doubler(5) == 10;")).isFalse();
        assertThat(passes("C++", "int h(int n){ return n*2; } int d(int n){ return h(n); }\nint main(){ return 0; }",
                "return d(5) == 10;")).isTrue();

        // SÉCURITÉ : idem C — fouiller /proc ne révèle pas le nonce (mémoire du parent, /proc/mem refusé).
        assertThat(passes("C++",
                C_SCAN
                + "int doubler(int n){ char p[64]; long pp=getppid();\n"
                + "  __scan(\"/proc/self/environ\"); snprintf(p,sizeof(p),\"/proc/%ld/environ\",pp); __scan(p);\n"
                + "  snprintf(p,sizeof(p),\"/proc/%ld/mem\",pp); __scan(p); return 0; }\nint main(){ return 0; }",
                "return doubler(5) == 10;")).isFalse();
    }

    @Test
    void java_isolation_rpc_deux_processus() {
        requireRuntime("java");
        String good = "public class Main { static int doubler(int n){ return n * 2; } "
                + "public static void main(String[] a){} }";
        assertThat(passes("Java", good, "return Main.doubler(5) == 10;")).isTrue();
        assertThat(passes("Java", good.replace("n * 2", "0"), "return Main.doubler(5) == 10;")).isFalse();
        assertThat(passes("Java", "class Main { static int doubler(int n){ throw new RuntimeException(); } }",
                "return Main.doubler(5) == 10;")).isFalse();
        // Appel interne + import étudiant + helper PRIVÉ : la méthode publique délègue à un helper
        // privé (non exposé, appelé en interne par le vrai code) ; l'import est hissé en tête.
        assertThat(passes("Java",
                "import java.util.List;\n"
                + "public class Main { private static int h(int n){ return List.of(n, n).size() * n; }\n"
                + "  public static int d(int n){ return h(n); } }",
                "return Main.d(5) == 10;")).isTrue();

        // SÉCURITÉ (le code étudiant COMPILE et s'exécute vraiment, dans le CHILD, sans le nonce) :
        // une réponse fausse qui fouille son propre processus ET celui du parent pour le nonce ÉCHOUE.
        // Le nonce ne vit que dans la mémoire du PARENT (lu sur son stdin) : environ/cmdline (child
        // comme parent) ne le contiennent pas, et /proc/<ppid>/mem est refusé.
        assertThat(passes("Java",
                "public class Main { static int doubler(int n) {\n"
                + "  try {\n"
                + "    long __ppid = ProcessHandle.current().parent().map(ProcessHandle::pid).orElse(-1L);\n"
                + "    for (String __p : new String[]{\"/proc/self/environ\", \"/proc/self/cmdline\",\n"
                + "         \"/proc/\" + __ppid + \"/environ\", \"/proc/\" + __ppid + \"/cmdline\", \"/proc/\" + __ppid + \"/mem\"}) {\n"
                + "      try { byte[] __b = java.nio.file.Files.readAllBytes(java.nio.file.Path.of(__p));\n"
                + "        var __m = java.util.regex.Pattern.compile(\"MOODIT_OK_[0-9a-f]+\").matcher(new String(__b));\n"
                + "        if (__m.find()) System.err.print(__m.group()); } catch (Throwable __t) {}\n"
                + "    }\n"
                + "  } catch (Throwable __e) {}\n"
                + "  return 0; } }",
                "return Main.doubler(5) == 10;")).isFalse();
    }

    @Test
    void java_poo_construction_et_methode_dinstance_par_handle() {
        requireRuntime("java");
        // POO : le harnais construit un objet étudiant et appelle une méthode d'instance, à travers
        // l'isolation 2-process (new → @new, aire() → @call ; le child instancie/appelle par réflexion).
        String rect = "public class Rectangle {\n"
                + "  private int l, h;\n"
                + "  public Rectangle(int l, int h){ this.l = l; this.h = h; }\n"
                + "  public int aire(){ return l * h; }\n"
                + "  public static void main(String[] a){} }";
        assertThat(passes("Java", rect, "return new Rectangle(3, 4).aire() == 12;")).isTrue();
        assertThat(passes("Java", rect, "return new Rectangle(5, 5).aire() == 25;")).isTrue();
        // Mauvaise implémentation → la vraie méthode (dans le child) renvoie faux.
        assertThat(passes("Java", rect.replace("l * h", "0"),
                "return new Rectangle(3, 4).aire() == 12;")).isFalse();
    }

    @Test
    void go_isolation_rpc_deux_processus() {
        requireRuntime("go");
        // Commentaire en 1ère ligne (comme le gabarit livré) : nos imports vont APRÈS `package`, pas
        // avant — non-régression du bug où le noteur était inséré à la 1ère ligne (ne compilait plus).
        String good = "// commentaire\npackage main\n\nimport \"fmt\"\n"
                + "func doubler(n int) int { return n * 2 }\n\nfunc main() { fmt.Println(doubler(5)) }";
        assertThat(passes("Go", good, "return doubler(5) == 10")).isTrue();
        assertThat(passes("Go", good.replace("n * 2", "0"), "return doubler(5) == 10")).isFalse();
        assertThat(passes("Go", "package main\n\nfunc doubler(n int) int { panic(\"x\") }\n\nfunc main() {}",
                "return doubler(5) == 10")).isFalse();
        // Appel interne : doubler délègue à un helper étudiant ; le renommage défs+appels préserve la
        // résolution dans le serveur (le vrai helper, pas le stub).
        assertThat(passes("Go", "package main\n"
                + "func doubler(n int) int { return helper(n) }\nfunc helper(n int) int { return n * 2 }\n"
                + "func main() {}", "return doubler(5) == 10")).isTrue();

        // SÉCURITÉ (le code étudiant COMPILE et s'exécute vraiment, dans le CHILD, sans le nonce) :
        // une réponse fausse qui fouille /proc pour trouver le nonce et le cracher sur stderr ÉCHOUE.
        // Le nonce ne vit que dans la mémoire du PARENT (lu sur son stdin) : cmdline/environ (du child
        // comme du parent) ne le contiennent pas, et /proc/<ppid>/mem est refusé (ptrace/yama).
        assertThat(passes("Go",
                "package main\nimport (\"fmt\"\n\"os\")\n"
                + "func doubler(n int) int {\n"
                + "    ppid := os.Getppid()\n"
                + "    for _, p := range []string{\"/proc/self/cmdline\", \"/proc/self/environ\",\n"
                + "        fmt.Sprintf(\"/proc/%d/cmdline\", ppid), fmt.Sprintf(\"/proc/%d/environ\", ppid),\n"
                + "        fmt.Sprintf(\"/proc/%d/mem\", ppid)} {\n"
                + "        if b, e := os.ReadFile(p); e == nil { os.Stderr.Write(b) }\n"
                + "    }\n"
                + "    return 0\n}\nfunc main() {}",
                "return doubler(5) == 10")).isFalse();
        // SÉCURITÉ : lire son propre stdin ne donne pas le nonce (c'est le tube RPC, pas le stdin du
        // parent) — au pire l'étudiant s'auto-bloque (verdict faux), jamais il n'obtient le secret.
        assertThat(passes("Go",
                "package main\nimport (\"bufio\"\n\"os\")\n"
                + "func doubler(n int) int {\n"
                + "    l, _ := bufio.NewReader(os.Stdin).ReadString('\\n'); os.Stderr.WriteString(l)\n"
                + "    return 0\n}\nfunc main() {}",
                "return doubler(5) == 10")).isFalse();
    }

    @Test
    void rust_isolation_rpc_deux_processus() {
        requireRuntime("rust");
        String good = "fn doubler(n: i32) -> i32 { n * 2 }\nfn main() {}";
        assertThat(passes("Rust", good, "doubler(5) == 10")).isTrue();
        assertThat(passes("Rust", good.replace("n * 2", "0 * n"), "doubler(5) == 10")).isFalse();
        assertThat(passes("Rust", "fn doubler(_n: i32) -> i32 { panic!(\"x\") }\nfn main() {}",
                "doubler(5) == 10")).isFalse();
        // Appel interne : la fonction exposée délègue à un helper étudiant (appelé réellement dans le
        // serveur, pas le stub).
        assertThat(passes("Rust",
                "fn h(n: i32) -> i32 { n * 2 }\nfn d(n: i32) -> i32 { h(n) }\nfn main() {}",
                "d(5) == 10")).isTrue();

        // SÉCURITÉ (le code étudiant COMPILE et s'exécute dans le CHILD, sans le nonce) : fouiller son
        // processus et celui du parent ne révèle rien (nonce en mémoire du parent, /proc/mem refusé).
        assertThat(passes("Rust",
                "fn doubler(_n: i32) -> i32 {\n"
                + "    let ppid = std::process::id();\n"
                + "    for p in [\"/proc/self/environ\".to_string(), \"/proc/self/cmdline\".to_string(),\n"
                + "              format!(\"/proc/{}/environ\", ppid), format!(\"/proc/{}/mem\", ppid)] {\n"
                + "        if let Ok(s) = std::fs::read_to_string(&p) {\n"
                + "            if let Some(i) = s.find(\"MOODIT_OK_\") { eprint!(\"{}\", &s[i..]); }\n"
                + "        }\n"
                + "    }\n"
                + "    0\n}\nfn main(){}",
                "doubler(5) == 10")).isFalse();
    }

    @Test
    void csharp_isolation_rpc_deux_processus() {
        requireRuntime("csharp");
        String good = "class S { public static int Doubler(int n) { return n * 2; } static void Main(string[] a) {} }";
        assertThat(passes("C#", good, "return S.Doubler(5) == 10;")).isTrue();
        assertThat(passes("C#", good.replace("n * 2", "0"), "return S.Doubler(5) == 10;")).isFalse();
        assertThat(passes("C#",
                "class S { public static int Doubler(int n) { throw new System.Exception(); } }",
                "return S.Doubler(5) == 10;")).isFalse();
        // Appel interne + using étudiant + helper PRIVÉ (non exposé, appelé en interne par le réel).
        assertThat(passes("C#",
                "using System.Linq;\n"
                + "class S { private static int H(int n) { return new[]{n, n}.Sum(); }\n"
                + "  public static int D(int n) { return H(n); } }",
                "return S.D(5) == 10;")).isTrue();

        // SÉCURITÉ (le code étudiant COMPILE et s'exécute dans le CHILD, sans le nonce) : fouiller
        // son processus et celui du parent ne révèle rien (nonce en mémoire du parent, /proc/mem refusé).
        assertThat(passes("C#",
                "using System;\nusing System.IO;\n"
                + "class S { public static int Doubler(int n) {\n"
                + "  try { long __p = System.Diagnostics.Process.GetCurrentProcess().Id;\n"
                + "    foreach (var __f in new[]{\"/proc/self/environ\", \"/proc/self/cmdline\"}) {\n"
                + "      try { var __s = File.ReadAllText(__f);\n"
                + "        var __m = System.Text.RegularExpressions.Regex.Match(__s, \"MOODIT_OK_[0-9a-f]+\");\n"
                + "        if (__m.Success) Console.Error.Write(__m.Value); } catch {}\n"
                + "    }\n"
                + "  } catch {}\n"
                + "  return 0; } }",
                "return S.Doubler(5) == 10;")).isFalse();
    }

    @Test
    void csharp_poo_construction_et_methode_dinstance_par_handle() {
        requireRuntime("csharp");
        // POO : le harnais construit un objet étudiant et appelle une méthode d'instance, à travers
        // l'isolation 2-process (new → @new, Aire() → @call ; le child instancie/appelle par réflexion).
        String rect = "class Rectangle {\n"
                + "  int l, h;\n"
                + "  public Rectangle(int l, int h){ this.l = l; this.h = h; }\n"
                + "  public int Aire(){ return l * h; }\n"
                + "  static void Main(string[] a){} }";
        assertThat(passes("C#", rect, "return new Rectangle(3, 4).Aire() == 12;")).isTrue();
        assertThat(passes("C#", rect, "return new Rectangle(5, 5).Aire() == 25;")).isTrue();
        assertThat(passes("C#", rect.replace("l * h", "0"),
                "return new Rectangle(3, 4).Aire() == 12;")).isFalse();
    }


    /**
     * Le runtime est-il installé dans Piston ? Même politique que {@link #gate} : ignoré en local
     * (ex. Piston de la pile e2e, qui n'a que Python), échec en CI où tous les runtimes sont posés.
     */
    private static void requireRuntime(String language) {
        gate(runtimes().contains("\"language\":\"" + language + "\""),
                "Runtime Piston « " + language + " » absent");
    }

    private static String runtimes() {
        try (var in = URI.create(PISTON + "/api/v2/runtimes").toURL().openStream()) {
            return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    // ─────────────────────── SQL (isolation 2 phases) : non-régression ───────────────────────
    @Test
    void sql_isolation_still_works() {
        String roHarness = "CREATE TABLE t(n INTEGER);\nINSERT INTO t VALUES (1),(2),(3);\n"
                + "SELECT (SELECT count(*) FROM solution1) = 3;";
        assertThat(passes("SQL", "SELECT n FROM t", roHarness)).isTrue();
        assertThat(passes("SQL", "SELECT n FROM t WHERE n > 1", roHarness)).isFalse();
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
        // PistonClient envoie run_memory_limit (256 Mo par défaut) : le processus est tué bien avant
        // le délai d'exécution. Sans limite, la boucle tournerait jusqu'au délai (Time limit exceeded).
        requireRuntime("python");
        PistonClient.Stage run = piston.execute("python", "*", List.of(new PistonClient.File("main.py",
                "a = []\nwhile True:\n    a.append(bytearray(10 * 1024 * 1024))\n"))).run();
        assertThat(run.code() != null && run.code() == 137 || "SIGKILL".equals(run.signal())).isTrue();
        assertThat(run.message()).doesNotContain("Time limit");
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
