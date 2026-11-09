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
        // Plusieurs filets peuvent mordre (sommaire incohérent, jeton absent) : on exige le
        // REFUS et un motif, sans figer lequel a joué.
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).isNotBlank();
    }

    @Test
    void test_unitaire_de_l_etudiant_qui_echoue_n_accuse_pas() {
        require("Rust");
        // L'idiome Rust le plus répandu : l'étudiant garde son propre module de tests, copié
        // d'un tutoriel, et SON test est faux. Ce test est découvert dans le cas CANARI (qui
        // embarque le code étudiant) : s'il y fait échouer le canari « pass », toute la
        // soumission est refusée avec « falsification probable » — alors qu'elle est honnête.
        String code = """
                pub fn doubler(n: i32) -> i32 { n * 2 }
                fn main() {}

                #[cfg(test)]
                mod tests {
                    use super::*;
                    #[test]
                    fn mon_test_a_moi() { assert_eq!(doubler(2), 5); }   // FAUX, mais honnête
                }
                """;
        List<TestResult> results = evaluate("Rust", code, """
                #[cfg(test)]
                mod moodit_tests {
                    use super::*;
                    #[test]
                    fn d() { assert_eq!(doubler(5), 10); }
                }
                """);
        // Le cas doit être RÉUSSI : le test (faux) de l'étudiant ne compte pas dans le
        // verdict, seul celui du harnais du prof est exécuté.
        assertThat(results.get(0).passed()).isTrue();
        assertThat(results.get(0).detail()).isNull();
    }

    @Test
    void test_unitaire_de_l_etudiant_qui_echoue_n_accuse_pas_java_et_csharp() {
        require("Java");
        // Même scénario qu'en Rust : l'étudiant garde un @Test / [Test] à lui, qui échoue.
        List<TestResult> java = evaluate("Java", """
                public class Solution {
                    static int doubler(int n) { return n * 2; }
                }
                class MesTests {
                    @org.junit.jupiter.api.Test
                    void aMoi() { org.junit.jupiter.api.Assertions.assertEquals(5, Solution.doubler(2)); }
                }
                """, """
                import org.junit.jupiter.api.Test;
                import static org.junit.jupiter.api.Assertions.assertEquals;

                class MooditHarness {
                    @Test
                    void doubler5() { assertEquals(10, Solution.doubler(5)); }
                }
                """);
        assertThat(java.get(0).passed()).isTrue();
        assertThat(java.get(0).detail()).isNull();

        require("C#");
        List<TestResult> cs = evaluate("C#", """
                using NUnit.Framework;
                public class Solution { public static int Doubler(int n) { return n * 2; } }
                public class MesTests {
                    [Test] public void AMoi() { Assert.That(Solution.Doubler(2), Is.EqualTo(5)); }
                }
                """, """
                using NUnit.Framework;
                public class MooditTests {
                    [Test] public void Doubler5() { Assert.That(Solution.Doubler(5), Is.EqualTo(10)); }
                }
                """);
        assertThat(cs.get(0).passed()).isTrue();
        assertThat(cs.get(0).detail()).isNull();
    }

    @Test
    void un_code_faux_echoue_meme_avec_des_tests_etudiants(/* contrôle négatif */) {
        require("Rust");
        // CONTRÔLE NÉGATIF du test précédent : même forme, mais le code étudiant est FAUX.
        // Sans lui, un filtrage qui écarterait AUSSI les tests du prof laisserait le cas
        // « réussi » et le test positif resterait vert — c'est ce trou qui a laissé passer
        // deux notes pleines sur du code arbitrairement faux.
        String faux = """
                pub fn doubler(n: i32) -> i32 { n * 3 }
                fn main() {}

                #[cfg(test)]
                mod tests {
                    use super::*;
                    #[test]
                    fn mon_test_a_moi() { assert_eq!(doubler(2), 6); }
                }
                """;
        List<TestResult> results = evaluate("Rust", faux, """
                #[cfg(test)]
                mod moodit_tests {
                    use super::*;
                    #[test]
                    fn d() { assert_eq!(doubler(5), 10); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
    }

    @Test
    void module_etudiant_court_ne_peut_pas_ecarter_le_harnais() {
        require("Rust");
        // « --skip s:: » filtre par SOUS-CHAÎNE : il écarterait « harnais::… ». Le nom est
        // neutralisé à l'assemblage, et l'invariant « un test du harnais a tourné » le
        // rattraperait de toute façon.
        String faux = """
                pub fn doubler(n: i32) -> i32 { n * 3 }
                fn main() {}

                #[cfg(test)]
                mod s {
                    use super::*;
                    // Test PERSONNEL qui RÉUSSIT : sans lui, le cas échouerait de toute façon
                    // faute de test à faire passer, et le contrôle ne distinguerait pas
                    // « le harnais a tourné » de « aucun test n'a tourné ».
                    #[test]
                    fn le_mien_passe() { assert_eq!(doubler(1), 3); }
                }
                """;
        List<TestResult> results = evaluate("Rust", faux, """
                #[cfg(test)]
                mod harnais {
                    use super::*;
                    #[test]
                    fn d() { assert_eq!(doubler(5), 10); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
    }

    @Test
    void nom_du_harnais_cite_en_commentaire_ne_l_ecarte_pas() {
        require("C#");
        // L'extraction est textuelle sur un texte que l'étudiant contrôle : citer le nom du
        // harnais dans un commentaire ferait sinon exclure les tests du prof — et NUnit
        // renvoyait « Passed » alors qu'AUCUN test n'avait tourné.
        String faux = """
                /*
                public class Harnais
                */
                public class Solution { public static int Doubler(int n) { return n * 3; } }

                // Test PERSONNEL qui RÉUSSIT : le cas ne peut devenir vert que si un test du
                // HARNAIS a réellement tourné, pas simplement « un test quelconque ».
                public class MesTestsAMoi {
                    [NUnit.Framework.Test] public void Mien() {
                        NUnit.Framework.Assert.That(Solution.Doubler(1), NUnit.Framework.Is.EqualTo(3));
                    }
                }
                """;
        List<TestResult> results = evaluate("C#", faux, """
                using NUnit.Framework;
                public class Harnais {
                    [Test] public void D() { Assert.That(Solution.Doubler(5), Is.EqualTo(10)); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
    }

    @Test
    void harnais_non_identifie_execute_quand_meme_ses_tests() {
        require("C#");
        // Harnais déclaré avec son attribut SUR LA MÊME LIGNE : la regex ne le capte pas.
        // Aucune exclusion n'est alors appliquée — ses tests tournent, et le code faux échoue.
        // C'est ce qui rend l'extraction non critique pour l'INTÉGRITÉ de la note.
        String faux = """
                public class Solution { public static int Doubler(int n) { return n * 3; } }

                public class MesTestsAMoi {
                    [NUnit.Framework.Test] public void Mien() {
                        NUnit.Framework.Assert.That(Solution.Doubler(1), NUnit.Framework.Is.EqualTo(3));
                    }
                }
                """;
        List<TestResult> results = evaluate("C#", faux, """
                using NUnit.Framework;
                [TestFixture] public class Harnais {
                    [Test] public void D() { Assert.That(Solution.Doubler(5), Is.EqualTo(10)); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
    }

    @Test
    void listing_tronque_ne_fait_pas_sauter_le_harnais() {
        require("Rust");
        // ATTAQUE : noyer `--list` sous assez de tests pour que sa sortie soit tronquée au
        // MILIEU — là où tombe le harnais. Le filtre bâti sur ce listing l'écartait, et seuls
        // les tests de l'étudiant tournaient : note pleine sur un code faux.
        StringBuilder faux = new StringBuilder("pub fn doubler(n: i32) -> i32 { n * 3 }\nfn main() {}\n");
        String nomLong = "t".repeat(200);
        for (String module : new String[] {"aaa", "zzz"}) {
            faux.append("#[cfg(test)]\nmod ").append(module).append(" {\n    use super::*;\n");
            for (int i = 0; i < 160; i++) {
                faux.append("    #[test]\n    fn ").append(nomLong).append(i)
                        .append("() { assert_eq!(doubler(1), 3); }\n");
            }
            faux.append("}\n");
        }
        List<TestResult> results = evaluate("Rust", faux.toString(), """
                #[cfg(test)]
                mod moodit_tests {
                    use super::*;
                    #[test]
                    fn d() { assert_eq!(doubler(5), 10); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
    }

    @Test
    void harnais_java_non_identifie_execute_quand_meme_ses_tests() {
        require("Java");
        // ATTAQUE : le harnais porte une annotation, donc la regex (ancrée sur les
        // modificateurs) ne le capte pas ; l'étudiant cite son nom en commentaire pour le
        // faire exclure et garde un test personnel QUI RÉUSSIT pour satisfaire le comptage.
        String faux = """
                /*
                class MooditHarness
                */
                public class Solution {
                    public static int doubler(int n) { return n * 3; }
                }
                """;
        List<TestResult> results = evaluate("Java", faux, """
                import org.junit.jupiter.api.Test;
                import static org.junit.jupiter.api.Assertions.*;

                @SuppressWarnings("all")
                class MooditHarness {
                    @Test void d() { assertEquals(10, Solution.doubler(5)); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
    }

    @Test
    void harnais_rust_non_identifie_execute_quand_meme_ses_tests() {
        require("Rust");
        // Même attaque en Rust : `#[cfg(test)] mod harnais {` sur une seule ligne échappe à la
        // regex, et l'étudiant cite « mod harnais » en commentaire.
        String faux = """
                pub fn doubler(n: i32) -> i32 { n * 3 }
                fn main() {}
                /*
                mod harnais
                */
                #[cfg(test)]
                mod a_moi {
                    use super::*;
                    #[test]
                    fn le_mien_passe() { assert_eq!(doubler(1), 3); }
                }
                """;
        List<TestResult> results = evaluate("Rust", faux, """
                #[cfg(test)] mod harnais {
                    use super::*;
                    #[test]
                    fn d() { assert_eq!(super::doubler(5), 10); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
    }

    @Test
    void harnais_java_a_classe_de_test_imbriquee_note_correctement() {
        require("Java");
        // JUnit rapporte un @Nested sous « Harnais$Cas » : sans tolérer l'imbrication,
        // l'invariant « un test du harnais a tourné » notait 0 TOUS les étudiants sur ce
        // harnais pourtant idiomatique. Code étudiant CORRECT → doit RÉUSSIR.
        List<TestResult> results = evaluate("Java", """
                public class Solution {
                    public static int doubler(int n) { return n * 2; }
                }
                """, """
                import org.junit.jupiter.api.Nested;
                import org.junit.jupiter.api.Test;
                import static org.junit.jupiter.api.Assertions.*;

                class Harnais {
                    @Nested
                    class Cas {
                        @Test void doubler5() { assertEquals(10, Solution.doubler(5)); }
                    }
                }
                """);
        assertThat(results.get(0).passed()).isTrue();
    }

    @Test
    void harnais_rust_a_tests_racine_note_correctement() {
        require("Rust");
        // Harnais qui déclare un module d'aide ET ses #[test] au niveau racine : ces tests
        // sont rapportés sous le nom de leur fonction, pas sous un module. Code étudiant
        // CORRECT → doit RÉUSSIR.
        List<TestResult> results = evaluate("Rust", """
                pub fn doubler(n: i32) -> i32 { n * 2 }
                fn main() {}
                """, """
                mod aides { pub const ATTENDU: i32 = 10; }

                #[cfg(test)]
                #[test]
                fn doubler5() { assert_eq!(crate::doubler(5), aides::ATTENDU); }
                """);
        assertThat(results.get(0).passed()).isTrue();
    }

    @Test
    void java_rapport_reecrit_et_code_de_sortie_ecrase_ne_suffisent_pas() {
        require("Java");
        // Le jeton prouvait que l'exécution était allée au bout, PAS que les tests passaient.
        // Le verdict arrivait par DEUX canaux que l'étudiant contrôle APRÈS son impression :
        // son rapport (sous work/, qui lui appartient) et le code de sortie du PROCESSUS. Ce
        // cas falsifie les deux depuis un hook d'arrêt — rapport crédible annonçant 0 échec
        // sur la vraie classe du harnais, puis halt(0) pour écraser le code de sortie.
        //
        // CONTRÔLE DE NON-RÉGRESSION : vérifié en simulant le retour du verdict sur exit_code,
        // ce test échoue alors. Il tient donc le CÂBLAGE « le verdict vient de la ligne du
        // jeton », pas seulement l'existence des fonctions qui le calculent.
        // (Attributs XML en apostrophes simples : valide, et évite l'échappement.)
        String faux = """
                import java.io.File;
                import java.io.FileWriter;

                public class Solution {
                    public static int doubler(int n) { return n * 3; }

                    static {
                        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                            try {
                                File dossier = new File("work/reports");
                                File[] rapports = dossier.listFiles();
                                if (rapports != null) {
                                    for (File rapport : rapports) { rapport.delete(); }
                                }
                                FileWriter sortie = new FileWriter(
                                        new File(dossier, "TEST-MooditHarness.xml"));
                                sortie.write("<testsuite tests='1' failures='0' errors='0'>"
                                        + "<testcase classname='MooditHarness' name='d'/>"
                                        + "</testsuite>");
                                sortie.close();
                            } catch (Exception ignore) {
                                // rien : l'essentiel est le halt(0) ci-dessous
                            }
                            Runtime.getRuntime().halt(0);
                        }));
                    }
                }
                """;
        List<TestResult> results = evaluate("Java", faux, """
                import org.junit.jupiter.api.Test;
                import static org.junit.jupiter.api.Assertions.*;

                class MooditHarness {
                    @Test void d() { assertEquals(10, Solution.doubler(5)); }
                }
                """);
        assertThat(results.get(0).passed()).isFalse();
    }

    @Test
    void panique_go_au_chargement_n_accuse_pas_de_falsification() {
        require("Go");
        // Le code étudiant est dans le MÊME `package main` que l'enveloppe et les canaris :
        // une panique à l'initialisation de paquet fait donc échouer TOUS les cas, canaris
        // compris. Et elle sort avec le statut 2 — ni expiration, ni signal — donc le verdict
        // des canaris y voyait une cause « concluante » et mettait toute la soumission à zéro
        // avec le bandeau de falsification, pour un bug d'initialisation banal.
        String faux = """
                package main

                var table = construire()

                func construire() map[string]int {
                    var m map[string]int
                    m["boum"] = 1          // panique : écriture dans une map nil
                    return m
                }

                func doubler(n int) int { return n * 2 }

                func main() {}
                """;
        List<TestResult> results = evaluate("Go", faux, """
                package main

                import "testing"

                func TestDoubler(t *testing.T) {
                    if doubler(5) != 10 {
                        t.Fatalf("doubler(5) = %d", doubler(5))
                    }
                }
                """);
        // Le cas échoue (le code ne tourne pas), mais SANS accusation.
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).doesNotContain("Incohérence")
                .doesNotContain("falsification")
                .doesNotContain("suspect");
    }

    @Test
    void tester_public_note_vraiment_les_cas() {
        require("Go");
        // Chemin PUBLIC (« Tester » du prof) : mur plafonné à PUBLIC_WALL_MS. Aucun test ne
        // l'empruntait, et une réserve de budget mal bornée y faisait répondre « Non exécuté :
        // budget de notation dépassé » sur TOUS les cas des six langages compilés.
        List<TestCaseInput> cases = List.of(new TestCaseInput("doubler", GO_HARNESS, 1));
        List<TestResult> results = evaluator.evaluate("Go", GO_OK, cases, null,
                DockerEvaluator.PUBLIC_WALL_MS);
        // passed=true et detail null : noté pour de bon, sans « budget de notation dépassé ».
        assertThat(results.get(0).passed()).isTrue();
        assertThat(results.get(0).detail()).isNull();
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
                    // IMPRIME : avec --nocapture, le « FAILED » du vrai test raté se retrouve
                    // alors SEUL sur sa ligne — c'est ce qui mettait en défaut un fil de
                    // détente ancré sur « ^test X ... FAILED$ » (exploit de la revue).
                    println!("sortie de la fonction notee");
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
        // Le test tricheur n'est même plus EXÉCUTÉ : seuls les modules du harnais et le
        // jeton le sont. L'attaque n'est plus détectée, elle est devenue impossible — le cas
        // échoue simplement parce que la réponse est fausse.
        assertThat(results.get(0).passed()).isFalse();
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
        // Le rapport forgé n'annonce AUCUN test exécuté (« total ») : le cas est refusé avant
        // même le contrôle du jeton. On exige le refus, sans figer quel filet a mordu.
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).isNotBlank();
    }
}
