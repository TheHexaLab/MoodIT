package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Filet d'INTÉGRATION du runner Docker des langages compilés (#116) : exerce le VRAI pipeline
 * (projet de test → conteneur runner → superviseur → verdicts) contre les vraies images
 * {@code moodit-runner-*}. Trois familles :
 * <ol>
 *   <li><b>Notation</b> : bonne réponse réussit, mauvaise échoue avec un détail du framework,
 *       la POO (constructeur + méthode d'instance, champs privés) est du simple code de test.</li>
 *   <li><b>Robustesse</b> : erreur de compilation → échec expliqué ; boucle infinie → timeout.</li>
 *   <li><b>ANTI-TRICHE</b> : forger la sortie du framework + {@code exit(0)} est attrapé par les
 *       CANARIS ; lire le harnais sur disque est refusé (EACCES) et DÉTECTÉ (strace).</li>
 * </ol>
 *
 * <p>Préconditions : démon Docker joignable + images construites ({@code docker/runners/build.sh}).
 * {@code SANDBOX_REQUIRED=true} (CI) : une précondition manquante FAIT ÉCHOUER le test — le filet
 * de sécurité ne doit pas s'ignorer en silence. Sinon (dev local) : test ignoré (assume).
 */
class DockerRunnerIntegrationTest {

    private static final boolean SANDBOX_REQUIRED =
            Boolean.parseBoolean(System.getenv().getOrDefault("SANDBOX_REQUIRED", "false"));

    // Tag surchargeable (MOODIT_RUNNER_TAG) : utile pour tester un lot d'images candidat.
    private final DockerEvaluator evaluator = new DockerEvaluator(
            new DockerSandbox("", 1536, 512, 2.0), "moodit-runner-",
            System.getenv().getOrDefault("MOODIT_RUNNER_TAG", "latest"));

    private static void gate(boolean available, String what) {
        if (available) {
            return;
        }
        if (SANDBOX_REQUIRED) {
            fail(what + " — indisponible alors que SANDBOX_REQUIRED=true : le filet anti-triche ne doit "
                    + "PAS s'ignorer en CI.");
        }
        assumeTrue(false, what + " — test d'intégration ignoré (dev local, SANDBOX_REQUIRED absent)");
    }

    private void require(String language) {
        gate(evaluator.sandbox().available(), "Démon Docker injoignable");
        String image = evaluator.imageFor(HarnessProjects.runnerLanguage(language));
        gate(evaluator.sandbox().imagePresent(image),
                "Image runner absente : " + image + " (docker/runners/build.sh)");
    }

    private List<TestResult> evaluate(String language, String code, String... harnesses) {
        List<TestCaseInput> cases = new java.util.ArrayList<>();
        for (int i = 0; i < harnesses.length; i++) {
            cases.add(new TestCaseInput("cas " + i, harnesses[i], 1));
        }
        return evaluator.evaluate(language, code, cases, null);
    }

    private boolean passes(String language, String code, String harness) {
        List<TestResult> results = evaluate(language, code, harness);
        return results.size() == 1 && results.get(0).passed();
    }

    // ─────────────────────────────── Go ───────────────────────────────

    private static final String GO_OK = "package main\n\nfunc doubler(n int) int { return n * 2 }\n\nfunc main() {}\n";
    private static final String GO_HARNESS = """
            package main

            import "testing"

            func TestDoubler(t *testing.T) {
                if doubler(5) != 10 {
                    t.Fatalf("doubler(5) = %d, attendu 10", doubler(5))
                }
            }
            """;

    @Test
    void go_notation_et_detail() {
        require("Go");
        assertThat(passes("Go", GO_OK, GO_HARNESS)).isTrue();
        List<TestResult> ko = evaluate("Go", GO_OK.replace("n * 2", "0"), GO_HARNESS);
        assertThat(ko.get(0).passed()).isFalse();
        assertThat(ko.get(0).detail()).contains("doubler(5) = 0");
    }

    @Test
    void go_forge_du_sommaire_attrapee_par_les_canaris() {
        require("Go");
        // init() imprime un faux sommaire « PASS » puis exit(0) : exit code ET sortie semblent bons —
        // seuls les canaris (dont le résultat attendu est tiré au sort à l'exécution) le trahissent.
        String cheater = """
                package main

                import (
                    "fmt"
                    "os"
                )

                func init() {
                    fmt.Println("=== RUN   TestDoubler")
                    fmt.Println("--- PASS: TestDoubler (0.00s)")
                    fmt.Println("PASS")
                    os.Exit(0)
                }

                func doubler(n int) int { return 0 }

                func main() {}
                """;
        List<TestResult> results = evaluate("Go", cheater, GO_HARNESS);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("⚠");
    }

    @Test
    void go_lecture_du_harnais_refusee_et_detectee() {
        require("Go");
        // Le code étudiant tente de lire le harnais verrouillé (700 root) : il reçoit une erreur,
        // et la tentative est tracée (événement « lecture_source_tentee » annexé au détail).
        String snooper = """
                package main

                import "os"

                func doubler(n int) int {
                    if _, err := os.ReadFile("src/solution_test.go"); err == nil {
                        return n * 2 // lecture réussie = la confidentialité serait rompue
                    }
                    return 0
                }

                func main() {}
                """;
        List<TestResult> results = evaluate("Go", snooper, GO_HARNESS);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("⚠ Comportement suspect");
    }

    @Test
    void go_timeout_interrompu() {
        require("Go");
        String infinite = "package main\n\nfunc doubler(n int) int { for {} }\n\nfunc main() {}\n";
        List<TestResult> results = evaluator.evaluate("Go", infinite,
                List.of(new TestCaseInput("t", GO_HARNESS, 1)), 2000);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("Interrompu");
    }

    // ─────────────────────────────── Java ───────────────────────────────

    private static final String JAVA_RECT = """
            public class Solution {
                public static class Rectangle {
                    private final int largeur;
                    private final int hauteur;
                    public Rectangle(int largeur, int hauteur) { this.largeur = largeur; this.hauteur = hauteur; }
                    public int aire() { return largeur * hauteur; }
                }
                public static void main(String[] args) {}
            }
            """;
    private static final String JAVA_HARNESS = """
            import org.junit.jupiter.api.Test;
            import static org.junit.jupiter.api.Assertions.assertEquals;

            class HarnessAire {
                @Test
                void aire() {
                    assertEquals(12, new Solution.Rectangle(3, 4).aire());
                }
            }
            """;

    @Test
    void java_poo_native_et_detail_junit() {
        require("Java");
        assertThat(passes("Java", JAVA_RECT, JAVA_HARNESS)).isTrue();
        List<TestResult> ko = evaluate("Java", JAVA_RECT.replace("largeur * hauteur", "0"), JAVA_HARNESS);
        assertThat(ko.get(0).passed()).isFalse();
        assertThat(ko.get(0).detail()).contains("expected: <12> but was: <0>");
    }

    @Test
    void java_erreur_de_compilation_expliquee() {
        require("Java");
        List<TestResult> results = evaluate("Java", "public class Solution { int x = ; }", JAVA_HARNESS);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("compilation");
    }

    @Test
    void java_exit_premature_dans_un_initialiseur_echoue() {
        require("Java");
        // Bloc static exécuté au chargement de Solution par le harnais : System.exit(0) tue la JVM
        // avec un exit « succès » avant la fin de JUnit → rapport incomplet → FAIL-CLOSED.
        String cheater = """
                public class Solution {
                    static { System.exit(0); }
                    public static class Rectangle {
                        public Rectangle(int l, int h) {}
                        public int aire() { return 0; }
                    }
                    public static void main(String[] args) {}
                }
                """;
        List<TestResult> results = evaluate("Java", cheater, JAVA_HARNESS);
        assertThat(results.get(0).passed()).isFalse();
    }

    // ─────────────────────────────── C# ───────────────────────────────

    private static final String CS_RECT = """
            using System;
            public class Rectangle {
                private readonly int largeur;
                private readonly int hauteur;
                public Rectangle(int l, int h) { largeur = l; hauteur = h; }
                public int Aire() { return largeur * hauteur; }
            }
            class Solution { static void Main() { Console.WriteLine(new Rectangle(3, 4).Aire()); } }
            """;
    private static final String CS_HARNESS = """
            using NUnit.Framework;
            public class HarnessAire {
                [Test]
                public void Aire() { Assert.That(new Rectangle(3, 4).Aire(), Is.EqualTo(12)); }
            }
            """;

    @Test
    void csharp_poo_native_malgre_le_main_etudiant() {
        require("C#");
        assertThat(passes("C#", CS_RECT, CS_HARNESS)).isTrue();
        List<TestResult> ko = evaluate("C#", CS_RECT.replace("largeur * hauteur", "0"), CS_HARNESS);
        assertThat(ko.get(0).passed()).isFalse();
        assertThat(ko.get(0).detail()).contains("Expected: 12");
    }

    // ─────────────────────────────── Rust ───────────────────────────────

    private static final String RUST_RECT = """
            struct Rectangle { largeur: i32, hauteur: i32 }
            impl Rectangle {
                fn new(l: i32, h: i32) -> Rectangle { Rectangle { largeur: l, hauteur: h } }
                fn aire(&self) -> i32 { self.largeur * self.hauteur }
            }
            fn main() { println!("{}", Rectangle::new(3, 4).aire()); }
            """;
    private static final String RUST_HARNESS = """
            #[cfg(test)]
            mod moodit_tests {
                use super::*;
                #[test]
                fn aire() { assert_eq!(Rectangle::new(3, 4).aire(), 12); }
            }
            """;

    @Test
    void rust_poo_native_champs_prives() {
        require("Rust");
        assertThat(passes("Rust", RUST_RECT, RUST_HARNESS)).isTrue();
        List<TestResult> ko = evaluate("Rust",
                RUST_RECT.replace("self.largeur * self.hauteur", "0"), RUST_HARNESS);
        assertThat(ko.get(0).passed()).isFalse();
        assertThat(ko.get(0).detail()).containsIgnoringCase("panicked");
    }

    // ─────────────────────────────── C et C++ ───────────────────────────────

    @Test
    void c_notation_et_poids() {
        require("C");
        String ok = "int doubler(int n) { return n * 2; }\nint main(void) { return 0; }\n";
        String harnessOk = "MOODIT_TEST(doubler_5) { MOODIT_CHECK(doubler(5) == 10); }\n";
        String harnessKo = "MOODIT_TEST(doubler_7) { MOODIT_CHECK(doubler(7) == 99); }\n";
        List<TestResult> results = evaluate("C", ok, harnessOk, harnessKo);
        assertThat(results.get(0).passed()).isTrue();
        assertThat(results.get(1).passed()).isFalse();
        assertThat(results.get(1).detail()).contains("doubler(7) == 99");
    }

    @Test
    void cpp_poo_native_champs_prives() {
        require("C++");
        String rect = """
                class Rectangle {
                    int largeur, hauteur;
                public:
                    Rectangle(int l, int h) : largeur(l), hauteur(h) {}
                    int aire() const { return largeur * hauteur; }
                };
                int main() { return 0; }
                """;
        String harness = "MOODIT_TEST(aire) { MOODIT_CHECK(Rectangle(3, 4).aire() == 12); }\n";
        assertThat(passes("C++", rect, harness)).isTrue();
        assertThat(passes("C++", rect.replace("largeur * hauteur", "0"), harness)).isFalse();
    }

    @Test
    void c_forge_du_sommaire_attrapee_par_les_canaris() {
        require("C");
        // Constructeur exécuté avant main : forge le sommaire moodit_check et sort en « succès ».
        String cheater = """
                #include <stdio.h>
                #include <stdlib.h>
                __attribute__((constructor)) static void forge(void) {
                    printf("[MOODIT] ok doubler_5\\n[MOODIT] summary total=1 failed=0\\n");
                    exit(0);
                }
                int doubler(int n) { return 0; }
                int main(void) { return 0; }
                """;
        List<TestResult> results = evaluate("C", cheater,
                "MOODIT_TEST(doubler_5) { MOODIT_CHECK(doubler(5) == 10); }\n");
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("⚠");
    }

    @Test
    void c_forge_depuis_la_fonction_notee_echoue_sans_jeton() {
        require("C");
        // Variante SILENCIEUSE pour les canaris : la forge vit DANS la fonction notée, qui ne
        // s'exécute jamais dans les cas canaris (leur harnais ne l'appelle pas). Le jeton de fin
        // d'exécution — imprimé seulement après tous les tests — la trahit : exit(0) le saute.
        String cheater = """
                #include <stdio.h>
                #include <stdlib.h>
                int doubler(int n) {
                    printf("[MOODIT] ok doubler_5\\n[MOODIT] summary total=1 failed=0\\n");
                    exit(0);
                }
                int main(void) { return 0; }
                """;
        List<TestResult> results = evaluate("C", cheater,
                "MOODIT_TEST(doubler_5) { MOODIT_CHECK(doubler(5) == 10); }\n");
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("jeton");
    }

    @Test
    void go_forge_depuis_la_fonction_notee_echoue_sans_jeton() {
        require("Go");
        // Même variante en Go : sommaire « PASS » forgé + os.Exit(0) depuis la fonction notée —
        // les canaris restent cohérents, seul le jeton de fin (imprimé par TestMain après
        // m.Run()) manque à l'appel.
        String cheater = """
                package main

                import (
                    "fmt"
                    "os"
                )

                func doubler(n int) int {
                    fmt.Println("--- PASS: TestDoubler (0.00s)")
                    fmt.Println("PASS")
                    os.Exit(0)
                    return 0
                }

                func main() {}
                """;
        List<TestResult> results = evaluate("Go", cheater, GO_HARNESS);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("jeton");
    }

    @Test
    void go_exfiltration_du_jeton_par_gabarit_rejetee() {
        require("Go");
        // Écrire __MOODIT_T__ dans sa copie recevrait le VRAI jeton à la substitution runtime :
        // le code est rejeté avant même de lancer un conteneur.
        String cheater = """
                package main

                import (
                    "fmt"
                    "os"
                )

                func doubler(n int) int {
                    fmt.Println("--- PASS: TestDoubler (0.00s)")
                    fmt.Println("PASS")
                    fmt.Println("[MOODIT] jeton=__MOODIT_T__")
                    os.Exit(0)
                    return 0
                }

                func main() {}
                """;
        List<TestResult> results = evaluate("Go", cheater, GO_HARNESS);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("Marqueur réservé");
    }

    @Test
    void cpp_forge_depuis_la_fonction_notee_echoue_sans_jeton() {
        require("C++");
        String cheater = """
                #include <cstdio>
                #include <cstdlib>
                int doubler(int n) {
                    std::printf("[MOODIT] ok doubler_5\\n[MOODIT] summary total=1 failed=0\\n");
                    std::exit(0);
                }
                int main() { return 0; }
                """;
        List<TestResult> results = evaluate("C++", cheater,
                "MOODIT_TEST(doubler_5) { MOODIT_CHECK(doubler(5) == 10); }\n");
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("jeton");
    }

    @Test
    void rust_forge_depuis_la_fonction_notee_echoue_sans_jeton() {
        require("Rust");
        // Sommaire libtest forgé + exit(0) : exit code et sortie semblent bons, le jeton
        // (test zzzz exécuté en dernier, --test-threads=1) manque à l'appel.
        String cheater = """
                pub fn doubler(n: i32) -> i32 {
                    println!("running 1 test");
                    println!("test moodit_tests::d ... ok");
                    println!("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
                    std::process::exit(0);
                }
                fn main() {}
                """;
        List<TestResult> results = evaluate("Rust", cheater, """
                #[cfg(test)]
                mod moodit_tests {
                    use super::*;
                    #[test]
                    fn d() { assert_eq!(doubler(5), 10); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("jeton");
    }

    @Test
    void java_temps_limite_court_plancher_vm() {
        require("Java");
        // 1 s de temps limite — valeur légitime pour un doubler : sans plancher, la JVM froide
        // tuait TOUS les cas (canaris compris) et le verdict accusait de « falsification
        // probable » une simple configuration. Le plancher VM (10 s, symétrique du mode exec)
        // doit laisser une soumission honnête passer, sans la moindre alerte.
        List<TestCaseInput> cases = List.of(new TestCaseInput("doubler", """
                import org.junit.jupiter.api.Test;
                import static org.junit.jupiter.api.Assertions.assertEquals;

                class MooditHarness {
                    @Test
                    void doubler5() { assertEquals(10, Solution.doubler(5)); }
                }
                """, 1));
        List<TestResult> results = evaluator.evaluate("Java",
                "public class Solution { static int doubler(int n) { return n * 2; } }",
                cases, 1_000);
        assertThat(results.get(0).passed()).isTrue();
        assertThat(results.get(0).detail()).isNull();
    }

    @Test
    void rust_forge_par_test_tardif_attrapee_par_le_fil_de_detente() {
        require("Rust");
        // Variante raffinée : un test étudiant zzzzz_* (trié APRÈS le jeton) imprime un
        // sommaire « ok » forgé puis exit(0) — exit 0, sommaire, jeton (déjà imprimé) et
        // canaris (fonction notée jamais appelée) passent tous. Seule la ligne
        // « test … ... FAILED » du vrai test raté, imprimée AVANT par libtest, le trahit.
        String cheater = """
                use std::sync::atomic::{AtomicBool, Ordering};
                pub static TRICHE: AtomicBool = AtomicBool::new(false);
                pub fn doubler(_n: i32) -> i32 {
                    TRICHE.store(true, Ordering::SeqCst);
                    0
                }
                fn main() {}

                #[cfg(test)]
                mod zzzzz_tricheur {
                    use super::*;
                    #[test]
                    fn t() {
                        if TRICHE.load(Ordering::SeqCst) {
                            println!("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
                            std::process::exit(0);
                        }
                    }
                }
                """;
        List<TestResult> results = evaluate("Rust", cheater, """
                #[cfg(test)]
                mod moodit_tests {
                    use super::*;
                    #[test]
                    fn d() { assert_eq!(doubler(5), 10); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("⚠");
    }

    @Test
    void csharp_rapport_nunit_forge_echoue_sans_jeton() {
        require("C#");
        // Le chemin du rapport est prévisible (work/nunit.xml, dossier étudiant) : un rapport
        // « Passed » forgé + Environment.Exit(0) satisfait exit code ET XML — seul le jeton
        // (imprimé par MooditRunner APRÈS Execute) le trahit.
        String cheater = """
                using System;
                using System.IO;

                public class Solution {
                    public static int Doubler(int n) {
                        File.WriteAllText("work/nunit.xml",
                            "<test-run result=\\"Passed\\" testcasecount=\\"1\\"></test-run>");
                        Environment.Exit(0);
                        return 0;
                    }
                }
                """;
        List<TestResult> results = evaluate("C#", cheater, """
                using NUnit.Framework;

                public class MooditTests {
                    [Test]
                    public void Doubler5() { Assert.That(Solution.Doubler(5), Is.EqualTo(10)); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("jeton");
    }
}
