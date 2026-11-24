package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * NOTATION NON FALSIFIABLE des six langages compilés. Le harnais du prof est du code simple qui
 * renvoie un BOOLÉEN (la forme d'avant #116) ; ce qui change, c'est qu'il n'est plus compilé avec
 * le code de l'étudiant : il vit dans un PROCESSUS SÉPARÉ, sous un UID SÉPARÉ, avec le nonce.
 *
 * <p>Trois exigences, vérifiées ici pour chaque langage :
 * <ol>
 *   <li>le harnais reste un simple corps booléen, et une bonne réponse passe ;</li>
 *   <li>l'étudiant ne peut pas FORGER son résultat ;</li>
 *   <li>l'étudiant ne peut ni LIRE ni MODIFIER le harnais du prof.</li>
 * </ol>
 *
 * <p>Les attaques rejouées sont celles qui MARCHAIENT contre le chemin framework (sortie forgée,
 * rapport forgé, sortie en zéro, jeton lu dans un artefact, jeton lu dans sa propre mémoire,
 * interposition de {@code printf}). Elles doivent échouer parce qu'il n'y a plus RIEN à attaquer
 * dans le processus de l'étudiant — pas parce qu'on les détecte.
 */
class RpcGradingIntegrationTest {

    private static final boolean SANDBOX_REQUIRED =
            Boolean.parseBoolean(System.getenv().getOrDefault("SANDBOX_REQUIRED", "false"));

    private final DockerEvaluator evaluator = new DockerEvaluator(
            new DockerSandbox("", 1536, 512, 2.0), "moodit-runner-",
            System.getenv().getOrDefault("MOODIT_RUNNER_TAG", "latest"));

    private void require(String language) {
        String image = evaluator.imageFor(HarnessProjects.runnerLanguage(language));
        if (!evaluator.sandbox().available() || !evaluator.sandbox().imagePresent(image)) {
            if (SANDBOX_REQUIRED) {
                fail("Démon Docker ou image " + image + " absents alors que SANDBOX_REQUIRED=true");
            }
            assumeTrue(false, "test d'intégration ignoré (dev local sans Docker ni image)");
        }
    }

    private TestResult note(String language, String harness, String code) {
        require(language);
        return evaluator.evaluate(language, code,
                List.of(new TestCaseInput("cas", harness, 1)), null).get(0);
    }

    /**
     * Détail d'un cas dont le HARNAIS a tourné et rendu faux. Les tests d'attaque l'affirment :
     * un refus venu d'ailleurs (charge qui ne compile plus, nom réservé, erreur du noteur,
     * processus soumis mort) laisserait {@code passed=false} sans que la défense visée ait été
     * mise à l'épreuve. Exclure le seul « Échec de compilation » ne voyait qu'un de ces cas.
     */
    private static final String HARNESS_FALSE = "Le harnais a renvoyé faux";

    // ───────────────────────────── 1. Le harnais booléen note ─────────────────────────────

    @Test
    void java_right_then_wrong_answer() {
        String h = "return Solution.doubler(5) == 10;";
        assertThat(note("Java", h, """
                public class Solution {
                    public static int doubler(int n) { return n * 2; }
                }
                """).passed()).isTrue();
        assertThat(note("Java", h, """
                public class Solution {
                    public static int doubler(int n) { return 0; }
                }
                """).passed()).isFalse();
    }

    @Test
    void go_right_then_wrong_answer() {
        String h = "return doubler(5) == 10";
        assertThat(note("Go", h, "package main\n\nfunc doubler(n int) int { return n * 2 }\n")
                .passed()).isTrue();
        assertThat(note("Go", h, "package main\n\nfunc doubler(n int) int { return 0 }\n")
                .passed()).isFalse();
    }

    @Test
    void c_right_then_wrong_answer() {
        String h = "return doubler(5) == 10;";
        assertThat(note("C", h, "int doubler(int n) { return n * 2; }\n").passed()).isTrue();
        assertThat(note("C", h, "int doubler(int n) { return 0; }\n").passed()).isFalse();
    }

    @Test
    void cpp_right_then_wrong_answer() {
        String h = "return doubler(5) == 10;";
        assertThat(note("C++", h, "int doubler(int n) { return n * 2; }\n").passed()).isTrue();
        assertThat(note("C++", h, "int doubler(int n) { return 0; }\n").passed()).isFalse();
    }

    @Test
    void cpp_default_arguments_are_graded() {
        // Une valeur par défaut (`int b = 0`) écartait la fonction, et un constructeur à valeurs
        // par défaut la classe entière : réponse juste notée 0, alors que la solution du prof,
        // écrite sans valeur par défaut, passait au « Tester ».
        String h = "return somme(2, 3) == 5;";
        assertThat(note("C++", h, "int somme(int a, int b = 0) { return a + b; }\n").passed()).isTrue();
        assertThat(note("C++", h, "int somme(int a, int b = 0) { return a - b; }\n").passed()).isFalse();
        String hRect = "Rect r(3, 4); return r.aire() == 12;";
        String code = """
                class Rect {
                    int l, h;
                public:
                    Rect(int w = 1, int hauteur = 1) { l = w; h = hauteur; }
                    int aire() { return l * h; }
                };
                """;
        assertThat(note("C++", hRect, code).passed()).isTrue();
        assertThat(note("C++", hRect, code.replace("l * h", "l + h")).passed()).isFalse();
    }

    @Test
    void rust_right_then_wrong_answer() {
        String h = "doubler(5) == 10";
        assertThat(note("Rust", h, "fn doubler(n: i32) -> i32 { n * 2 }\n").passed()).isTrue();
        assertThat(note("Rust", h, "fn doubler(n: i32) -> i32 { 0 }\n").passed()).isFalse();
    }

    @Test
    void rust_submitted_pub_main_is_graded() {
        // Revue #246 : un `pub fn main()` soumis n'était pas renommé et doublait le `main` du
        // serveur généré (E0428) — 0 sur une réponse juste. Le `main` d'un sous-module, que le
        // code soumis appelle, reste intact.
        String h = "doubler(5) == 10";
        String code = """
                mod outils {
                    pub fn main() -> i32 { 2 }
                }

                pub fn doubler(n: i32) -> i32 { n * outils::main() }

                pub fn main() {
                    println!("{}", doubler(2));
                }
                """;
        TestResult right = note("Rust", h, code);
        assertThat(right.passed()).as(String.valueOf(right.detail())).isTrue();
        assertThat(note("Rust", h, code.replace("{ 2 }", "{ 3 }")).passed()).isFalse();
    }

    @Test
    void rust_private_main_of_a_submodule_is_graded() {
        // Revue #246 : un `fn main()` nu de sous-module était renommé sans que son appel le
        // soit — échec de compilation et 0 sur une réponse juste.
        String h = "doubler(5) == 10";
        String code = """
                mod outils {
                    fn main() -> i32 { 2 }
                    pub fn deux() -> i32 { main() }
                }

                pub fn doubler(n: i32) -> i32 { n * outils::deux() }
                """;
        TestResult right = note("Rust", h, code);
        assertThat(right.passed()).as(String.valueOf(right.detail())).isTrue();
        assertThat(note("Rust", h, code.replace("{ 2 }", "{ 3 }")).passed()).isFalse();
    }

    @Test
    void csharp_region_with_an_apostrophe_is_graded() {
        // Revue #246 : l'apostrophe d'un `#region` blanchissait le reste du fichier pour
        // l'extraction — « Aucune méthode exploitable » et 0 sur une réponse juste.
        String h = "return Solution.Doubler(5) == 10;";
        String code = """
                public class Solution {
                    #region Méthodes d'aide
                    public static int Doubler(int n) { return n * 2; }
                    #endregion
                }
                """;
        TestResult right = note("C#", h, code);
        assertThat(right.passed()).as(String.valueOf(right.detail())).isTrue();
        assertThat(note("C#", h, code.replace("n * 2", "0")).passed()).isFalse();
    }

    @Test
    void c_error_directive_with_an_apostrophe_is_graded() {
        // Même défaut en C : l'apostrophe d'une directive ouvrait un littéral jamais fermé.
        String h = "return doubler(5) == 10;";
        String code = """
                #ifdef JAMAIS_DEFINI
                #error l'entrée manque
                #endif
                int doubler(int n) { return n * 2; }
                """;
        TestResult right = note("C", h, code);
        assertThat(right.passed()).as(String.valueOf(right.detail())).isTrue();
        assertThat(note("C", h, code.replace("n * 2", "0")).passed()).isFalse();
    }

    @Test
    void csharp_right_then_wrong_answer() {
        String h = "return Solution.Doubler(5) == 10;";
        assertThat(note("C#", h, """
                public class Solution {
                    public static int Doubler(int n) { return n * 2; }
                }
                """).passed()).isTrue();
        assertThat(note("C#", h, """
                public class Solution {
                    public static int Doubler(int n) { return 0; }
                }
                """).passed()).isFalse();
    }

    @Test
    void csharp_static_without_modifier_is_graded() {
        // En C# un membre de classe est PRIVÉ par défaut : c'est l'écriture la plus naturelle
        // d'un exercice, et elle doit être notée. Avant le correctif, l'extraction acceptait la
        // signature mais le serveur la résolvait en `BindingFlags.Public` : le bouchon était
        // généré, le noteur compilait, puis l'appel échouait à l'exécution. Une réponse JUSTE
        // était notée 0, avec un diagnostic qui accusait le code de l'étudiant.
        String h = "return Solution.Doubler(5) == 10;";
        assertThat(note("C#", h, """
                class Solution {
                    static int Doubler(int n) { return n * 2; }
                }
                """).passed()).isTrue();
        // Et la mauvaise réponse reste fausse : le chemin n'est pas devenu permissif.
        assertThat(note("C#", h, """
                class Solution {
                    static int Doubler(int n) { return 0; }
                }
                """).passed()).isFalse();
    }

    @Test
    void java_object_without_modifier_is_graded() {
        // Visibilité de PAQUET sur la classe, le constructeur et la méthode : un exercice POO
        // écrit sans cérémonie. Le serveur sait déjà l'invoquer (getDeclared* +
        // setAccessible) ; seule l'extraction exigeait `public`, et refusait donc une
        // soumission correcte avec « aucune méthode statique ni objet exploitable ».
        String h = "return new Solution.Rectangle(3, 4).aire() == 12;";
        assertThat(note("Java", h, """
                public class Solution {
                    static class Rectangle {
                        private final int largeur;
                        private final int hauteur;
                        Rectangle(int largeur, int hauteur) {
                            this.largeur = largeur;
                            this.hauteur = hauteur;
                        }
                        int aire() { return largeur * hauteur; }
                    }
                }
                """).passed()).isTrue();
        assertThat(note("Java", h, """
                public class Solution {
                    static class Rectangle {
                        Rectangle(int largeur, int hauteur) { }
                        int aire() { return 0; }
                    }
                }
                """).passed()).isFalse();
    }

    @Test
    void java_static_in_secondary_class_is_graded() {
        // Le bouchon aplatit les statiques de TOUTES les classes dans la principale : le
        // harnais « Solution.doubler(5) » compile même si l'étudiant a mis la fonction dans
        // une classe à côté. Le serveur doit donc chercher dans le même périmètre — sinon
        // l'appel levait à l'exécution et une réponse JUSTE était notée 0.
        String h = "return Solution.doubler(5) == 10;";
        String twoClasses = """
                public class Solution {
                }

                class Outils {
                    static int doubler(int n) { return n * 2; }
                }
                """;
        assertThat(note("Java", h, twoClasses).passed()).isTrue();
        assertThat(note("Java", h, twoClasses.replace("n * 2", "0")).passed()).isFalse();
    }

    @Test
    void csharp_static_in_secondary_class_is_graded() {
        String h = "return Solution.Doubler(5) == 10;";
        String twoClasses = """
                class Solution {
                }
                class Outils {
                    static int Doubler(int n) { return n * 2; }
                }
                """;
        assertThat(note("C#", h, twoClasses).passed()).isTrue();
        assertThat(note("C#", h, twoClasses.replace("n * 2", "0")).passed()).isFalse();
    }

    @Test
    void commented_version_above_real_class_is_graded() {
        // Le réflexe courant : garder l'ancienne version en commentaire. Le choix de la classe
        // principale se fait sur la source DÉPOUILLÉE — sans cela, le fichier déposé (Java) et
        // les typeof du serveur (C#) étaient nommés d'après la classe commentée, et la
        // soumission correcte échouait sur un type que l'étudiant n'a pas écrit.
        assertThat(note("Java", "return Solution.doubler(5) == 10;", """
                /* Premier essai :
                public class Brouillon {
                    static int doubler(int n) { return n + n; }
                }
                */
                public class Solution {
                    static int doubler(int n) { return n * 2; }
                }
                """).passed()).isTrue();
        assertThat(note("C#", "return Solution.Doubler(5) == 10;", """
                // class Principale { }
                class Solution {
                    static int Doubler(int n) { return n * 2; }
                }
                """).passed()).isTrue();
    }

    @Test
    void java_package_rejected_with_clear_diagnostic() {
        // Un `package ...;` colle depuis un IDE faisait compiler la classe dans un sous-dossier :
        // la decouverte plate la manquait, et le cas tombait dans « aucune methode exploitable »
        // — un 0 avec un message qui ne designe pas la cause. Desormais : un diagnostic qui dit
        // de retirer la ligne. Code par ailleurs CORRECT.
        TestResult r = note("Java", "return Solution.doubler(5) == 10;", """
                package exo1;

                public class Solution {
                    static int doubler(int n) { return n * 2; }
                }
                """);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("package");
    }

    @Test
    void go_float_tolerance_with_math_abs() {
        // L'idiome des questions a reponse flottante : comparer a une tolerance. Le noteur Go
        // n'importait pas « math » — un harnais ecrit AUJOURD'HUI ainsi ne compilait pas.
        String h = "return math.Abs(moitie(3)-1.5) < 1e-9";
        assertThat(note("Go", h, """
                package main

                func moitie(n int) float64 { return float64(n) / 2 }
                """).passed()).isTrue();
        assertThat(note("Go", h, """
                package main

                func moitie(n int) float64 { return 0 }
                """).passed()).isFalse();
    }

    @Test
    void rust_commented_field_graded_correctly() {
        // La forme de la demo V2_3, avec un commentaire de champ. Les champs etaient lus sur la
        // source BRUTE : « // en cm, environ » faisait perdre `hauteur`, et le litteral du
        // harnais ne compilait plus — 0 sur une reponse juste.
        String h = "Rectangle { largeur: 3, hauteur: 4 }.aire() == 12";
        assertThat(note("Rust", h, """
                struct Rectangle {
                    largeur: i32, // en cm, environ
                    hauteur: i32,
                }
                impl Rectangle {
                    fn aire(&self) -> i32 { self.largeur * self.hauteur }
                }
                """).passed()).isTrue();
    }

    @Test
    void go_tagged_field_graded_correctly() {
        // Une etiquette `json:"l"` faisait perdre toute la structure, lue sur la source brute.
        String h = "return Rectangle{Largeur: 3, Hauteur: 4}.Aire() == 12";
        assertThat(note("Go", h, """
                package main

                type Rectangle struct {
                	Largeur int `json:"l"`
                	Hauteur int
                }

                func (r Rectangle) Aire() int { return r.Largeur * r.Hauteur }
                """).passed()).isTrue();
    }

    @Test
    void rust_solution_importing_write_graded_correctly() {
        // `use std::io::Write;` (banal pour un flush) levait E0252 : le SERVEUR, qui partage le
        // fichier de l'etudiant, importait Write sans alias.
        assertThat(note("Rust", "doubler(5) == 10", """
                use std::io::Write;

                fn doubler(n: i32) -> i32 {
                    std::io::stdout().flush().unwrap();
                    n * 2
                }
                """).passed()).isTrue();
    }

    @Test
    void java_top_level_class_graded_correctly() {
        // `class Rectangle` A COTE de Solution : le bouchon la rangeait dans Solution, et
        // `new Rectangle(3, 4)` ne compilait plus — 0 pour toute la question. La forme imbriquee
        // (Solution.Rectangle) reste couverte par java_objets_par_poignee.
        String h = "return new Rectangle(3, 4).aire() == 12;";
        assertThat(note("Java", h, """
                public class Solution {
                }

                class Rectangle {
                    private final int l;
                    private final int h;
                    Rectangle(int l, int h) { this.l = l; this.h = h; }
                    int aire() { return l * h; }
                }
                """).passed()).isTrue();
    }

    @Test
    void java_helper_class_named_like_java_lang_is_graded() {
        // Revue #246 : une `class Long` d'aide, que le harnais ne nomme pas, recevait un bouchon
        // dans le paquet du noteur, où il masquait java.lang.Long pour le runtime généré —
        // « Le harnais ne compile pas » et 0 sur une réponse juste. Plus de bouchon pour elle.
        String h = "return Solution.doubler(2) == 4;";
        String code = """
                public class Solution {
                    static int doubler(int n) { return new Long(n).get() * 2; }
                }

                class Long {
                    private final int v;
                    Long(int v) { this.v = v; }
                    int get() { return v; }
                }
                """;
        TestResult right = note("Java", h, code);
        assertThat(right.passed()).as(String.valueOf(right.detail())).isTrue();
        assertThat(note("Java", h, code.replace("* 2", "* 3")).passed()).isFalse();
    }

    @Test
    void csharp_long_type_names_graded_correctly() {
        // `String` EST `string`, `Int32` EST `int` : aucun bouchon n'etait genere et une reponse
        // juste etait notee 0. Garde l'APPEL : l'extraction C# passe par cs_canonical_types.
        assertThat(note("C#", "return Solution.Inverse(\"ab\") == \"ba\";", """
                using System;

                class Solution {
                    public static String Inverse(String s) {
                        char[] c = s.ToCharArray();
                        Array.Reverse(c);
                        return new String(c);
                    }
                }
                """).passed()).isTrue();
    }

    @Test
    void c_static_function_and_const_parameter_graded_correctly() {
        assertThat(note("C", "return doubler(5) == 10;",
                "static int doubler(const int n) { return n * 2; }").passed()).isTrue();
    }

    // ───────── Formes courantes qui valaient 0 (28e passe) : la juste passe, la fausse non ─────────

    @Test
    void csharp_double_returns_static_and_object() {
        // `InvariantCulture` devenait `InbrutariantCulture` dans la lecture d'un double : le
        // harnais ne compilait plus des qu'une methode rendait un double.
        // Une classe de bouchons par question : chemin statique et chemin objet, chacun le sien.
        String staticCode = """
                class Solution {
                    public static double Moitie(int n) { return n / 2.0; }
                }
                """;
        String hs = "return Solution.Moitie(3) == 1.5;";
        assertThat(note("C#", hs, staticCode).passed()).isTrue();
        assertThat(note("C#", hs, staticCode.replace("n / 2.0", "n / 3.0")).passed()).isFalse();
        String objectCode = """
                class Rect {
                    int l, h;
                    public Rect(int l, int h) { this.l = l; this.h = h; }
                    public double Aire() { return l * h / 2.0; }
                }
                """;
        String ho = "return System.Math.Abs(new Rect(3, 4).Aire() - 6.0) < 1e-9;";
        assertThat(note("C#", ho, objectCode).passed()).isTrue();
        assertThat(note("C#", ho, objectCode.replace("/ 2.0", "/ 3.0")).passed()).isFalse();
    }

    @Test
    void rust_constructor_returning_self() {
        String h = "Rect::new(3, 4).aire() == 12";
        String code = """
                pub struct Rect { l: i64, h: i64 }
                impl Rect {
                    pub fn new(l: i64, h: i64) -> Self { Rect { l, h } }
                    pub fn aire(&self) -> i64 { self.l * self.h }
                }
                """;
        assertThat(note("Rust", h, code).passed()).isTrue();
        assertThat(note("Rust", h, code.replace("self.l * self.h", "self.l + self.h")).passed()).isFalse();
    }

    @Test
    void cpp_overload_called_is_the_harness_one() {
        // `Rect()` declare AVANT `Rect(int, int)` : l'aiguillage par nom construisait `Rect()`.
        String h = "return Rect(3, 4).aire() == 12;";
        String code = """
                class Rect {
                    int l, h;
                public:
                    Rect() { l = 0; h = 0; }
                    Rect(int a, int b) { l = a; h = b; }
                    int aire() { return l * h; }
                };
                """;
        assertThat(note("C++", h, code).passed()).isTrue();
        assertThat(note("C++", h, code.replace("l * h", "l + h")).passed()).isFalse();
    }

    @Test
    void java_anonymous_and_local_classes_graded_correctly() {
        // `Solution$1` (Comparator anonyme) et `Solution$1Acc` (classe locale) recevaient un
        // bouchon `class 1 { … }` : le noteur ne compilait plus et une réponse juste valait 0.
        String h = "return Solution.plusGrand(3, 9, 4) == 9 && Solution.somme(4) == 10;";
        String code = """
                import java.util.*;
                public class Solution {
                    static int plusGrand(int a, int b, int c) {
                        List<Integer> l = new ArrayList<>(List.of(a, b, c));
                        l.sort(new Comparator<Integer>() {
                            public int compare(Integer x, Integer y) { return Integer.compare(y, x); }
                        });
                        return l.get(0);
                    }
                    static int somme(int n) {
                        class Acc { int t; void add(int v) { t += v; } }
                        Acc acc = new Acc();
                        for (int i = 1; i <= n; i++) { acc.add(i); }
                        return acc.t;
                    }
                }
                """;
        assertThat(note("Java", h, code).passed()).isTrue();
        assertThat(note("Java", h, code.replace("compare(y, x)", "compare(x, y)")).passed()).isFalse();
    }

    @Test
    void java_overloads_of_same_arity_resolved_by_types() {
        // Le serveur choisissait la première méthode de même nom et même arité : `moitie(7)`
        // pouvait appeler `moitie(double)`, et une réponse juste était notée fausse.
        String h = "return Solution.moitie(7) == 3 && Solution.moitie(7.0) == 3.5"
                + " && new Solution.Rect(3).aire() == 3 && new Solution.Rect(3.0).aire() == 9"
                + " && new Solution.Rect(2).plus(1) == 3 && new Solution.Rect(2).plus(1.0) == 2.5;";
        String code = """
                public class Solution {
                    static double moitie(double x) { return x / 2; }
                    static int moitie(int n) { return n / 2; }
                    static class Rect {
                        int l, h;
                        Rect(double c) { l = (int) c; h = (int) c; }
                        Rect(int a) { l = a; h = 1; }
                        int aire() { return l * h; }
                        int plus(int n) { return aire() + n; }
                        double plus(double d) { return aire() + d / 2; }
                    }
                }
                """;
        assertThat(note("Java", h, code).passed()).isTrue();
        assertThat(note("Java", h, code.replace("n / 2", "n / 3")).passed()).isFalse();
    }

    @Test
    void csharp_overloads_of_same_arity_resolved_by_types() {
        // Même défaut qu'en Java : le serveur résolvait par nom et arité seulement.
        String h = "return new Rect(3).Aire() == 3 && new Rect(3.0).Aire() == 9"
                + " && new Rect(2).Plus(1) == 3 && new Rect(2).Plus(1.0) == 2.5"
                + " && Rect.Moitie(7) == 3 && Rect.Moitie(7.0) == 3.5;";
        String code = """
                public class Rect {
                    int l, h;
                    public Rect(double c) { l = (int) c; h = (int) c; }
                    public Rect(int a) { l = a; h = 1; }
                    public int Aire() { return l * h; }
                    public int Plus(int n) { return Aire() + n; }
                    public double Plus(double d) { return Aire() + d / 2; }
                    public static double Moitie(double x) { return x / 2; }
                    public static int Moitie(int n) { return n / 2; }
                }
                """;
        assertThat(note("C#", h, code).passed()).isTrue();
        assertThat(note("C#", h, code.replace("n / 2", "n / 3")).passed()).isFalse();
    }

    @Test
    void cpp_explicit_and_virtual() {
        String h = "return Carre(3).aire() == 9;";
        String code = """
                class Carre {
                    int c;
                public:
                    explicit Carre(int x) { c = x; }
                    virtual int aire() { return c * c; }
                };
                """;
        assertThat(note("C++", h, code).passed()).isTrue();
        assertThat(note("C++", h, code.replace("c * c", "c + c")).passed()).isFalse();
    }

    @Test
    void c_graded_function_named_like_libc_is_refused() {
        // Une fonction soumise au nom d'une fonction de la libc fournie au harnais prendrait sa
        // place dans le noteur : le harnais ne peut pas distinguer l'outil de la fonction notee.
        // Refus explicite, meme pour une reponse juste.
        String h = "return abs(-5) == 5;";
        TestResult r = note("C", h, "int abs(int n) { return n < 0 ? -n : n; }");
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("réservé").contains("abs");
    }

    @Test
    void submitted_library_function_cannot_forge_a_floating_point_harness() {
        // Forge corrigee : une `fabs` soumise qui renvoie 0 faisait passer
        // `fabs(f(x) - attendu) < 1e-9` quel que soit f, canaris compris.
        String h = "return fabs(moitie(5) - 2.5) < 1e-9;";
        String forged = """
                double fabs(double x) { return 0; }
                double moitie(int n) { return 0; }
                """;
        for (String language : List.of("C", "C++")) {
            TestResult r = note(language, h, forged);
            assertThat(r.passed()).as(language).isFalse();
            assertThat(r.detail()).as(language).contains("réservé").contains("fabs");
        }
        // Meme chose par une macro de <math.h>.
        TestResult macro = note("C", "return !isnan(moitie(5)) && moitie(5) == 2.5;",
                "int isnan(double x) { return 0; }\ndouble moitie(int n) { return 2.5; }\n");
        assertThat(macro.passed()).isFalse();
        assertThat(macro.detail()).contains("réservé").contains("isnan");
    }

    @Test
    void go_submitted_function_cannot_shadow_a_builtin() {
        // En Go, `func max` au niveau du paquet masquait la fonction INTEGREE max du harnais.
        TestResult r = note("Go", "return max(doubler(2), 0) == 4",
                "package main\n\nfunc doubler(n int) int { return 0 }\n\n"
                        + "func max(a, b int) int { return 4 }\n");
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("réservé").contains("max");
    }

    @Test
    void c_submitted_function_named_like_a_compiler_builtin_is_refused() {
        // Revue #246 : `HUGE_VAL` se développe en `__builtin_huge_val ()`. Une fonction soumise
        // de ce nom était renommée par #define dans le noteur et détournait la constante du
        // harnais. Déclarée pour de bon, elle est refusée (nom réservé à l'implémentation).
        String forged = """
                #define __builtin_huge_val() 42.0
                double __builtin_huge_val(void) { return 0; }
                double divise(double a, double b) { return 42.0; }
                """;
        for (String language : List.of("C", "C++")) {
            TestResult r = note(language, "return divise(1.0, 0.0) == HUGE_VAL;", forged);
            assertThat(r.passed()).as(language).isFalse();
            assertThat(r.detail()).as(language).contains("réservé").contains("__builtin_huge_val");
        }
        // Cachée sous `#if 0`, elle n'existe pas dans le code compilé : les signatures sont lues
        // sur le code aux directives traitées, aucun bouchon de ce nom n'entre dans le noteur, et
        // c'est le harnais intact qui juge la réponse fausse (42 n'est pas HUGE_VAL).
        String hidden = """
                #define __builtin_huge_val() 42.0
                #if 0
                double __builtin_huge_val(void) { return 0; }
                #endif
                double divise(double a, double b) { return 42.0; }
                """;
        for (String language : List.of("C", "C++")) {
            TestResult r = note(language, "return divise(1.0, 0.0) == HUGE_VAL;", hidden);
            assertThat(r.passed()).as(language).isFalse();
            assertThat(r.detail()).as(language).isEqualTo("Le harnais a renvoyé faux");
        }
    }

    @Test
    void go_submitted_type_or_constructor_cannot_shadow_a_builtin() {
        // Revue #246 : les noms de type et les constructeurs de l'API objet sont déclarés au
        // niveau du paquet du noteur, comme les fonctions : même refus explicite (ici un
        // constructeur `recover`, qui masquait la fonction intégrée du même nom).
        TestResult r = note("Go", "return NewBoite(2).Valeur() == 2",
                "package main\n\ntype Boite struct{ v int }\n\n"
                        + "func NewBoite(v int) *Boite { return &Boite{v} }\n\n"
                        + "func recover() *Boite { return &Boite{0} }\n\n"
                        + "func (b *Boite) Valeur() int { return b.v }\n");
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("réservé").contains("recover");
    }

    @Test
    void go_pointer_receiver_is_graded_with_a_literal_harness() {
        // Revue #246 : c'est l'étudiant qui choisit son récepteur. Avec `*Rectangle`, le type
        // sortait de la capture de champs et la question POO de la démo notait 0 (« Aucune
        // fonction exploitable ») sur une réponse juste.
        String code = """
                package main

                type Rectangle struct {
                	largeur int
                	hauteur int
                }

                func (r *Rectangle) aire() int { return r.largeur * r.hauteur }
                func (r *Rectangle) agrandir(k int) int { r.largeur *= k; return r.largeur }
                func (r Rectangle) perimetre() int { return 2 * (r.largeur + r.hauteur) }
                """;
        String demo = "r := Rectangle{largeur: 3, hauteur: 4}\nreturn r.aire() == 12";
        assertThat(note("Go", demo, code).passed()).isTrue();
        assertThat(note("Go", demo, code.replace("r.largeur * r.hauteur", "r.largeur + r.hauteur"))
                .passed()).isFalse();
        // La modification faite par une méthode à récepteur pointeur est REPORTÉE dans l'objet
        // du harnais ; la perdre en silence donnerait un verdict faux.
        String mutation = "r := Rectangle{largeur: 3, hauteur: 4}\nr.agrandir(2)\n"
                + "return r.aire() == 24 && r.perimetre() == 20";
        assertThat(note("Go", mutation, code).passed()).isTrue();
        assertThat(note("Go", mutation, code.replace("r.largeur *= k", "_ = k")).passed()).isFalse();
    }

    @Test
    void types_without_field_or_declared_constructor_are_graded() {
        // Revue #246 : Java et C# fournissaient le constructeur par défaut, pas ces trois-là.
        String go = "package main\n\ntype Calculatrice struct{}\n\n"
                + "func (c *Calculatrice) additionner(a, b int) int { return a + b }\n";
        String goHarness = "c := Calculatrice{}\nreturn c.additionner(2, 3) == 5";
        assertThat(note("Go", goHarness, go).passed()).isTrue();
        assertThat(note("Go", goHarness, go.replace("a + b", "a - b")).passed()).isFalse();

        String rust = "struct Calculatrice;\n\nimpl Calculatrice {\n"
                + "    fn additionner(&self, a: i32, b: i32) -> i32 { a + b }\n}\n";
        String rustHarness = "let c = Calculatrice;\nc.additionner(2, 3) == 5";
        assertThat(note("Rust", rustHarness, rust).passed()).isTrue();
        assertThat(note("Rust", rustHarness, rust.replace("a + b", "a - b")).passed()).isFalse();

        String cpp = "class Calculatrice {\npublic:\n"
                + "    int additionner(int a, int b) { return a + b; }\n};\n";
        String cppHarness = "Calculatrice c;\nreturn c.additionner(2, 3) == 5;";
        assertThat(note("C++", cppHarness, cpp).passed()).isTrue();
        assertThat(note("C++", cppHarness, cpp.replace("a + b", "a - b")).passed()).isFalse();
    }

    @Test
    void cpp_abstract_base_class_does_not_break_the_submitted_program() {
        // Revue #246 : la classe abstraite recevait un `push_back(Forme(...))` dans l'aiguillage
        // généré — « Échec de compilation » sur un exercice d'héritage juste.
        String code = """
                class Forme {
                public:
                    Forme(double l, double h) : l(l), h(h) {}
                    virtual double aire() const = 0;
                    virtual ~Forme() {}
                protected:
                    double l, h;
                };

                class Rectangle : public Forme {
                public:
                    Rectangle(double l, double h) : Forme(l, h) {}
                    double aire() const override { return l * h; }
                };
                """;
        String h = "Rectangle r(3, 4);\nreturn fabs(r.aire() - 12) < 1e-9;";
        assertThat(note("C++", h, code).passed()).isTrue();
        assertThat(note("C++", h, code.replace("l * h", "l + h")).passed()).isFalse();
    }

    @Test
    void helper_named_like_a_builtin_is_graded_when_the_harness_does_not_use_it() {
        // Revue #246 : le refus « Nom réservé » ne vise plus que le nom que le harnais emploie.
        String go = "package main\n\nfunc max(a, b int) int {\n\tif a > b {\n\t\treturn a\n\t}\n"
                + "\treturn b\n}\n\nfunc plusGrand(a, b, c int) int { return max(a, max(b, c)) }\n";
        assertThat(note("Go", "return plusGrand(2, 9, 3) == 9", go).passed()).isTrue();
        assertThat(note("Go", "return plusGrand(2, 9, 3) == 9", go.replace("a > b", "a < b"))
                .passed()).isFalse();
        String c = "int abs(int x) { return x < 0 ? -x : x; }\n"
                + "int distance(int a, int b) { return abs(a - b); }\n";
        assertThat(note("C", "return distance(2, 5) == 3;", c).passed()).isTrue();
        // En C++ aussi : le serveur n'inclut plus <stdlib.h> après le code soumis, la
        // redéfinition n'y heurte plus rien.
        assertThat(note("C++", "return distance(2, 5) == 3;", c).passed()).isTrue();
        assertThat(note("C++", "return distance(2, 5) == 3;", c.replace("-x : x", "0 : 0"))
                .passed()).isFalse();
    }

    @Test
    void java_secondary_class_statics_and_cause_of_a_submitted_exception() {
        // Revue #246 : les statiques d'une classe secondaire n'étaient déclarées que dans la
        // classe principale (« cannot find symbol »), et le motif d'une exception du code
        // soumis se perdait derrière InvocationTargetException.
        String code = "class Aide {\n    static int carre(int n) { return n * n; }\n}\n"
                + "class Solution {\n    static int sommeCarres(int a, int b) {"
                + " return Aide.carre(a) + Aide.carre(b); }\n"
                + "    static int div(int a, int b) { return a / b; }\n}\n";
        String h = "return Solution.sommeCarres(3, 4) == 25 && Aide.carre(3) == 9;";
        assertThat(note("Java", h, code).passed()).isTrue();
        TestResult r = note("Java", "return Solution.div(1, 0) == 0;", code);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("ArithmeticException");
    }

    @Test
    void legitimate_forms_that_were_not_recognized_are_graded() {
        // Revue #246 : chacune de ces écritures donnait « aucune fonction exploitable » ou « le
        // harnais ne compile pas » — 0 sur une réponse juste.
        // C++ : déclaration dans la classe sans noms de paramètres, définitions dehors.
        gradedThenWrong("C++", "Rect r(3, 4); return r.aire() == 12;", """
                class Rect {
                    int l, h;
                public:
                    Rect(int, int);
                    int aire();
                };
                Rect::Rect(int a, int b) : l(a), h(b) {}
                int Rect::aire() { return l * h; }
                """, "l * h", "l + h");
        // C : même fonction définie dans les deux branches du préprocesseur.
        gradedThenWrong("C", "return fact(5) == 120;", """
                #if 0
                int fact(int n) { return 0; }
                #else
                int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
                #endif
                """, "n * fact", "n + fact");
        // Go : résultat nommé.
        gradedThenWrong("Go", "return Double(5) == 10", """
                package main

                func Double(n int) (r int) {
                \tr = n * 2
                \treturn
                }

                func main() {}
                """, "n * 2", "n + 2");
        // Rust : méthode d'un trait implémenté, et méthode par défaut du trait.
        gradedThenWrong("Rust", "Carre::new(3).aire() == 9 && Carre::new(2).double_aire() == 8", """
                pub trait Forme {
                    fn aire(&self) -> i32;
                    fn double_aire(&self) -> i32 { 2 * self.aire() }
                }
                pub struct Carre { c: i32 }
                impl Carre {
                    pub fn new(c: i32) -> Self { Carre { c } }
                }
                impl Forme for Carre {
                    fn aire(&self) -> i32 { self.c * self.c }
                }
                fn main() {}
                """, "self.c * self.c", "self.c + self.c");
        // Java : statique d'une classe secondaire homonyme d'une statique de la principale — le
        // serveur exécutait celle de la principale (faux verdict muet).
        gradedThenWrong("Java", "return Aide.calcul(3) == 9 && Solution.calcul(3) == 10;", """
                class Aide {
                    static int calcul(int n) { return n * n; }
                }
                public class Solution {
                    static int calcul(int n) { return Aide.calcul(n) + 1; }
                    public static void main(String[] args) { }
                }
                """, "n * n", "n + n");
        // C++ : `operator()` dans une classe, constructeur sur deux lignes, qualificatifs.
        gradedThenWrong("C++", "Rect r(3, 4); return somme_carres(3, 4) == 25 && r.aire() == 12;", """
                struct Carre {
                    int operator()(int x) const { return x * x; }
                };
                class Rect {
                    int l, h;
                public:
                    Rect(int largeur,
                         int hauteur) : l(largeur), h(hauteur) {}
                    [[nodiscard]] int aire() const noexcept { return l * h; }
                };
                constexpr int somme_carres(int a, int b) noexcept { return Carre{}(a) + Carre{}(b); }
                """, "l * h", "l + h");
        // Rust : `const fn`.
        gradedThenWrong("Rust", "carre(5) == 25", """
                pub const fn carre(x: i32) -> i32 { x * x }
                fn main() {}
                """, "x * x", "x + x");
        // Java : méthode `default` d'une interface MÈRE de celle que la classe implémente.
        gradedThenWrong("Java", "return new Carre(3).doubleAire() == 18;", """
                interface Forme {
                    int aire();
                    default int doubleAire() { return 2 * aire(); }
                }
                interface Polygone extends Forme { }
                class Carre implements Polygone {
                    private final int c;
                    Carre(int c) { this.c = c; }
                    public int aire() { return c * c; }
                }
                public class Solution {
                    public static void main(String[] args) { }
                }
                """, "c * c", "c + c");
        // Java : méthode `default` d'une interface, non redéfinie.
        gradedThenWrong("Java", "return new Carre(3).doubleAire() == 18;", """
                interface Forme {
                    int aire();
                    default int doubleAire() { return 2 * aire(); }
                }
                class Carre implements Forme {
                    private final int c;
                    Carre(int c) { this.c = c; }
                    public int aire() { return c * c; }
                }
                public class Solution {
                    public static void main(String[] args) { }
                }
                """, "c * c", "c + c");
    }

    @Test
    void derived_classes_receivers_and_annotated_structs_are_graded() {
        // Revue #246 (3e tour) : chacune de ces écritures donnait « aucune fonction exploitable »
        // ou « 'Carre' was not declared » — 0 sur une réponse juste.
        // C++ : dérivée `final`, constructeurs repris par `using`, défaut implicite d'une
        // dérivée, `virtual public`, étiquette `public :`.
        gradedThenWrong("C++", "Carre k(3); Cube u(2); Derivee d; Calc c;"
                + " return k.aire() == 9 && u.aire() == 4 && d.un() == 1 && c.add(2, 3) == 5;", """
                class Forme {
                public:
                    Forme(int c) : c(c) {}
                    int aire() { return c * c; }
                protected:
                    int c;
                };
                class Carre final : public Forme {
                public:
                    Carre(int c) : Forme(c) {}
                };
                class Cube : public Forme {
                public:
                    using Forme::Forme;
                };
                struct Base { int un() { return 1; } };
                struct Derivee final : virtual public Base { };
                class Calc {
                public :
                    int add(int a, int b) { return a + b; }
                };
                """, "c * c", "c + c");
        // Go : récepteurs sans nom, par valeur et par pointeur.
        gradedThenWrong("Go", "return Calculatrice{}.Additionner(2, 3) == 5 && (&Calculatrice{}).Un() == 1", """
                package main

                type Calculatrice struct{}

                func (Calculatrice) Additionner(a, b int) int { return a + b }

                func (*Calculatrice) Un() int { return 1 }

                func main() {}
                """, "a + b", "a - b");
        // Rust : attribut sur la ligne de la structure, visibilité `pub(crate)`.
        gradedThenWrong("Rust", "Rectangle { largeur: 3, hauteur: 4 }.aire() == 12"
                + " && Carre { c: 2 }.aire() == 4", """
                #[derive(Debug, Clone)] struct Rectangle { largeur: i32, hauteur: i32 }
                impl Rectangle {
                    fn aire(&self) -> i32 { self.largeur * self.hauteur }
                }
                pub(crate) struct Carre { c: i32 }
                impl Carre {
                    fn aire(&self) -> i32 { self.c * self.c }
                }
                fn main() {}
                """, "self.largeur * self.hauteur", "self.largeur + self.hauteur");
        // Go : un `max` d'aide cité seulement en commentaire du harnais n'est pas refusé.
        gradedThenWrong("Go", "// le plus grand (max) des trois\nreturn PlusGrand(1, 5, 3) == 5", """
                package main

                func max(a, b int) int {
                \tif a > b {
                \t\treturn a
                \t}
                \treturn b
                }

                func PlusGrand(a, b, c int) int { return max(max(a, b), c) }

                func main() {}
                """, "return max(max(a, b), c)", "return a");
    }

    @Test
    void abstract_intermediates_preprocessor_macros_embedding_and_attributes_are_graded() {
        // Revue #246 (4e tour) : chacune de ces écritures notait 0 une réponse juste.
        // C++ : classe intermédiaire restée abstraite sans le déclarer (`new` illégal dans le
        // serveur), constructeur par défaut protégé de la base, type de retour seul sur sa ligne,
        // `long int`.
        gradedThenWrong("C++", "Carre k(3); Derivee d; Calc c;"
                + " return k.aire() == 9 && k.cotes() == 4 && d.deux() == 2"
                + " && c.somme(2, 3) == 5 && c.grand(7) == 7000;", """
                class Forme {
                public:
                    virtual int aire() = 0;
                    virtual ~Forme() {}
                };
                class Polygone : public Forme {
                protected:
                    int n;
                public:
                    Polygone(int n) : n(n) {}
                    int cotes() { return n; }
                };
                class Carre : public Polygone {
                    int c;
                public:
                    Carre(int c) : Polygone(4), c(c) {}
                    int aire() { return c * c; }
                };
                class Base {
                protected:
                    Base() {}
                public:
                    int un() { return 1; }
                };
                class Derivee : public Base {
                public:
                    int deux() { return un() + 1; }
                };
                class Calc {
                public:
                    int
                    somme(int a, int b) const { return a + b; }
                    long int grand(long int x) { return x * 1000; }
                };
                """, "c * c", "c + c");
        // C++ : `#define int long long` (programmation compétitive) ne déborde plus sur le serveur.
        gradedThenWrong("C++", "return carre(5) == 25;", """
                #define int long long
                int carre(int x) { return x * x; }
                signed main() { return 0; }
                """, "x * x", "x + x");
        // C : fonction écartée par le préprocesseur, que le serveur appelait.
        gradedThenWrong("C", "return doubler(4) == 8;", """
                #ifdef DEBUG
                int trace(int x) { return x; }
                #endif
                int doubler(int x) { return 2 * x; }
                """, "2 * x", "3 * x");
        // Go : méthode promue par composition.
        gradedThenWrong("Go", "return NewCarre(3).Aire() == 9", """
                package main

                type Rectangle struct {
                    l, h int
                }

                func (r *Rectangle) Aire() int { return r.l * r.h }

                type Carre struct {
                    Rectangle
                }

                func NewCarre(c int) *Carre { return &Carre{Rectangle{c, c}} }

                func main() {}
                """, "r.l * r.h", "r.l + r.h");
        // Rust : attribut sur la ligne de la fonction.
        gradedThenWrong("Rust", "doubler(4) == 8", """
                #[inline] pub fn doubler(x: i32) -> i32 { 2 * x }
                fn main() {}
                """, "2 * x", "3 * x");
    }

    @Test
    void default_arguments_references_and_inactive_branches_are_graded() {
        // Revue #246 (5e tour) : chacune de ces écritures notait 0 une réponse juste.
        // C++ : valeurs par défaut (constructeur et accumulateur), référence constante, méthode
        // sous `#ifdef` d'une classe qui reste.
        gradedThenWrong("C++", "Rect a; Rect b(3, 4); return a.aire() == 1 && b.aire() == 12"
                + " && somme(4) == 10 && somme(4, 1) == 11 && carre(5) == 25;", """
                class Rect {
                    int l, h;
                public:
                    Rect(int largeur = 1, int hauteur = 1) : l(largeur), h(hauteur) {}
                    int aire() { return l * h; }
                #ifdef DEBUG
                    int trace() { return l; }
                #endif
                };
                int somme(int n, int acc = 0) { return n == 0 ? acc : somme(n - 1, acc + n); }
                int carre(const int& x) { return x * x; }
                """, "l * h", "l + h");
        // C++ : valeur par défaut sur le PROTOTYPE, définition après `main` sans elle.
        gradedThenWrong("C++", "return somme(4) == 10 && somme(4, 1) == 11;", """
                int somme(int n, int acc = 0);
                int main() { return 0; }
                int somme(int n, int acc) { return n == 0 ? acc : somme(n - 1, acc + n); }
                """, "acc + n", "acc * n");
        // C++ : un fichier qui s'inclut lui-même au préprocesseur seul (faux à la vraie
        // compilation, où il s'appelle autrement) n'est lu qu'une fois — chaque niveau le
        // recopiait, et l'extraction tenait le conteneur jusqu'au mur (revue #246).
        gradedThenWrong("C++", "return doubler(4) == 8;", """
                #if __INCLUDE_LEVEL__ < 150 && __has_include("pp.cpp")
                #include "pp.cpp"
                #endif
                int doubler(int x) { return 2 * x; }
                """, "2 * x", "3 * x");
        // C : ancienne version d'arité différente sous `#if 0`, avant la vraie.
        gradedThenWrong("C", "return somme(4) == 10;", """
                #if 0
                long somme(long a, long b) { return a + b; }
                #endif
                int somme(int n) { return n == 0 ? 0 : n + somme(n - 1); }
                """, "n + somme", "n * somme");
        // C# : statique et méthode d'instance à valeur par défaut.
        gradedThenWrong("C#", "return Solution.Somme(4) == 10 && Solution.Somme(4, 1) == 11;", """
                public class Solution {
                    public static int Somme(int n, int acc = 0) {
                        return n == 0 ? acc : Somme(n - 1, acc + n);
                    }
                    public static void Main() { }
                }
                """, "acc + n", "acc * n");
        gradedThenWrong("C#", "return new Calc().Echelle(3) == 6 && new Calc().Echelle(3, 3) == 9;", """
                public class Calc {
                    public int Echelle(int x, int k = 2) { return x * k; }
                }
                """, "x * k", "x + k");
    }

    @Test
    void java_public_class_declared_after_an_import_on_the_same_line_is_graded() {
        // Revue #246 : la classe publique n'était reconnue qu'en début de ligne. Le fichier
        // déposé prenait un autre nom, et javac refusait « class Rectangle is public, should be
        // declared in a file named Rectangle.java » — 0 sur une réponse juste.
        gradedThenWrong("Java", "return new Rectangle(3, 4).aire() == 12;",
                "import java.util.*; public class Rectangle { private final int l, h;"
                        + " public Rectangle(int l, int h) { this.l = l; this.h = h; }"
                        + " public int aire() { return l * h; } }\n",
                "l * h", "l + h");
    }

    @Test
    void inherited_method_is_graded_in_java_csharp_and_cpp() {
        // Revue #246 : le bouchon ne portait que les méthodes DÉCLARÉES par la classe. L'étudiant
        // qui hérite `aire()` de `Forme` au lieu de la redéfinir dans `Carre` recevait « le
        // harnais ne compile pas », donc 0, quand la solution du prof (qui redéfinit) passait.
        gradedThenWrong("Java", "return new Carre(3).aire() == 9 && new Carre(4).cote() == 4;", """
                class Forme {
                    protected final int c;
                    Forme(int c) { this.c = c; }
                    public int aire() { return c * c; }
                }
                class Carre extends Forme {
                    Carre(int c) { super(c); }
                    public int cote() { return c; }
                }
                public class Solution {
                    public static void main(String[] args) { }
                }
                """, "c * c", "c + c");
        gradedThenWrong("C#", "return new Carre(3).Aire() == 9;", """
                public class Forme {
                    protected int c;
                    public Forme(int c) { this.c = c; }
                    public int Aire() { return c * c; }
                }
                public class Carre : Forme {
                    public Carre(int c) : base(c) { }
                }
                """, "c * c", "c + c");
        gradedThenWrong("C++", "Carre k(3); return k.aire() == 9;", """
                class Forme {
                public:
                    Forme(int c) : c(c) {}
                    int aire() { return c * c; }
                protected:
                    int c;
                };
                class Carre : public Forme {
                public:
                    Carre(int c) : Forme(c) {}
                };
                """, "c * c", "c + c");
        // Règle C++ : `aire(int)` dans la dérivée MASQUE `aire()` de la base. Le serveur généré
        // ne doit pas l'appeler sur `Carre` — sinon il ne compile plus, et une réponse juste
        // (qui surcharge dans la dérivée) recevait « Échec de compilation ».
        gradedThenWrong("C++", "Carre k(3); Forme f(2); return k.aire(2) == 18 && f.aire() == 4;", """
                class Forme {
                public:
                    Forme(int c) : c(c) {}
                    int aire() { return c * c; }
                protected:
                    int c;
                };
                class Carre : public Forme {
                public:
                    Carre(int c) : Forme(c) {}
                    int aire(int k) { return k * c * c; }
                };
                """, "k * c * c", "k + c");
    }

    @Test
    void submitted_code_that_crashes_fails_in_the_six_compiled_languages() {
        // Critère de #116 : une exception ou un panic du code soumis échoue, dans CHAQUE langage
        // compilé. Le témoin plante seulement sur 999 et réussit ; la variante plante sur
        // l'appel du harnais. Elle doit échouer à l'EXÉCUTION : un échec de compilation ferait
        // passer ce test sans rien mesurer.
        record Crash(String lang, String harness, String code) { }
        List<Crash> crashes = List.of(
                new Crash("Go", "return doubler(5) == 10", """
                        package main

                        func doubler(n int) int {
                        \tif n == 999 {
                        \t\tpanic("boum")
                        \t}
                        \treturn n * 2
                        }

                        func main() {}
                        """),
                new Crash("Rust", "doubler(5) == 10", """
                        fn doubler(n: i32) -> i32 {
                            if n == 999 { panic!("boum"); }
                            n * 2
                        }

                        fn main() {}
                        """),
                new Crash("C", "return doubler(5) == 10;", """
                        int doubler(int n) {
                            if (n == 999) { __builtin_trap(); }
                            return n * 2;
                        }
                        """),
                new Crash("C++", "return doubler(5) == 10;", """
                        int doubler(int n) {
                            if (n == 999) { throw 42; }
                            return n * 2;
                        }
                        """),
                new Crash("C#", "return Solution.doubler(5) == 10;", """
                        class Solution {
                            public static int doubler(int n) {
                                if (n == 999) { throw new System.InvalidOperationException("boum"); }
                                return n * 2;
                            }
                        }
                        """),
                new Crash("Java", "return Solution.doubler(5) == 10;", """
                        class Solution {
                            static int doubler(int n) {
                                if (n == 999) { throw new IllegalStateException("boum"); }
                                return n * 2;
                            }
                        }
                        """));
        for (Crash c : crashes) {
            TestResult ok = note(c.lang(), c.harness(), c.code());
            assertThat(ok.passed()).as(c.lang() + " : témoin " + ok.detail()).isTrue();
            TestResult crash = note(c.lang(), c.harness(), c.code().replace("999", "5"));
            assertThat(crash.passed()).as(c.lang() + " : plantage").isFalse();
            assertThat(crash.detail()).as(c.lang() + " : plantage")
                    .isNotBlank().doesNotContainIgnoringCase("compilation");
        }
    }

    @Test
    void csharp_namespace_helper_nested_class_and_method_named_Double() {
        String h = "return Solution.Double(4) == 8;";
        String code = """
                using System;
                namespace Quiz {
                    class Aide { public static int Un() { return 1; } }
                    class Solution {
                        class Interne { }
                        public static int Double(int n) { return 2 * n; }
                    }
                }
                """;
        assertThat(note("C#", h, code).passed()).isTrue();
        assertThat(note("C#", h, code.replace("return 2 * n;", "return n;")).passed()).isFalse();
    }

    @Test
    void csharp_class_without_declared_constructor() {
        String h = "return new Compteur().Trois() == 3;";
        String code = "class Compteur { public int Trois() { return 3; } }";
        assertThat(note("C#", h, code).passed()).isTrue();
        assertThat(note("C#", h, code.replace("return 3;", "return 2;")).passed()).isFalse();
    }

    @Test
    void java_annotation_with_arguments_on_class_line() {
        String h = "return Solution.doubler(5) == 10;";
        String code = """
                class Aide { }
                @SuppressWarnings("unchecked") public class Solution {
                    public static int doubler(int n) { return n * 2; }
                }
                """;
        assertThat(note("Java", h, code).passed()).isTrue();
        assertThat(note("Java", h, code.replace("n * 2", "n")).passed()).isFalse();
    }

    @Test
    void java_same_static_in_nested_class() {
        // Deux bouchons `calcul(int)` dans la meme classe : le noteur ne compilait plus.
        String h = "return Solution.calcul(3) == 7;";
        String code = """
                public class Solution {
                    static class Aide {
                        static int calcul(int n) { return n * 2; }
                    }
                    public static int calcul(int n) { return Aide.calcul(n) + 1; }
                }
                """;
        assertThat(note("Java", h, code).passed()).isTrue();
        assertThat(note("Java", h, code.replace("+ 1;", "+ 2;")).passed()).isFalse();
    }

    @Test
    void csharp_same_static_in_helper_class() {
        String h = "return Solution.Calcul(3) == 7;";
        String code = """
                class Solution {
                    public static int Calcul(int n) { return Aide.Calcul(n) + 1; }
                }
                class Aide {
                    public static int Calcul(int n) { return n * 2; }
                }
                """;
        assertThat(note("C#", h, code).passed()).isTrue();
        assertThat(note("C#", h, code.replace("+ 1;", "+ 2;")).passed()).isFalse();
    }

    // ───────── Bouchons objet bornes a LEUR classe ; en-tetes du noteur C (31e passe) ─────────

    @Test
    void csharp_two_classes_with_same_instance_method() {
        String h = "return new Rectangle(3, 4).Aire() == 12;";
        String code = """
                class Rectangle {
                    int l, h;
                    public Rectangle(int l, int h) { this.l = l; this.h = h; }
                    public int Aire() { return l * h; }
                }
                class Carre {
                    int c;
                    public Carre(int c) { this.c = c; }
                    public int Aire() { return c * c; }
                }
                """;
        assertThat(note("C#", h, code).passed()).isTrue();
        assertThat(note("C#", h, code.replace("l * h", "l + h")).passed()).isFalse();
    }

    @Test
    void csharp_inheritance_with_override() {
        String h = "return new Carre(3).Aire() == 9;";
        String code = """
                abstract class Forme {
                    public abstract int Aire();
                }
                class Carre : Forme {
                    int c;
                    public Carre(int c) { this.c = c; }
                    public override int Aire() { return c * c; }
                }
                """;
        assertThat(note("C#", h, code).passed()).isTrue();
        assertThat(note("C#", h, code.replace("c * c", "c + c")).passed()).isFalse();
    }

    @Test
    void rust_constructor_and_methods_in_two_impl_blocks() {
        String h = "R::new(3).double() == 6";
        String code = """
                pub struct R { l: i64 }
                impl R {
                    pub fn new(l: i64) -> Self { R { l } }
                }
                impl R {
                    pub fn double(&self) -> i64 { self.l * 2 }
                }
                """;
        assertThat(note("Rust", h, code).passed()).isTrue();
        assertThat(note("Rust", h, code.replace("self.l * 2", "self.l")).passed()).isFalse();
    }

    @Test
    void cpp_nested_class() {
        String h = "return A(3).f() == 6;";
        String code = """
                class A {
                    int x;
                public:
                    class B {
                    public:
                        B(int y) { }
                        int g() { return 1; }
                    };
                    A(int v) { x = v; }
                    int f() { return x * 2; }
                };
                """;
        assertThat(note("C++", h, code).passed()).isTrue();
        assertThat(note("C++", h, code.replace("x * 2", "x")).passed()).isFalse();
    }

    @Test
    void c_harness_with_fabs_true_and_round() {
        // Le prof ne peut pas ecrire d'#include : <math.h> et <stdbool.h> lui sont fournis, et
        // ses outils (fabs, round) restent ceux de la libc.
        String h = "return fabs(moitie(5) - 2.5) < 1e-9 && round(2.6) == 3 && true;";
        String code = """
                double moitie(int n) { return n / 2.0; }
                """;
        assertThat(note("C", h, code).passed()).isTrue();
        assertThat(note("C", h, code.replace("n / 2.0", "n / 3.0")).passed()).isFalse();
        assertThat(note("C++", h, code).passed()).isTrue();
    }

    @Test
    void no_submitted_process_survives_into_the_next_case() {
        require("C");
        // Isolation entre les cas : chaque appel laisse derriere lui un processus detache dont le
        // fil PRINCIPAL est sorti (affiche « zombie », mais un autre fil tourne encore), et
        // compte d'abord les processus de son propre UID. Le balayage entre deux cas jugeait ce
        // processus mort sur l'etat de son seul fil principal, et le laissait vivre au cas
        // suivant. Trois cas reels : quel que soit l'ordre tire, deux d'entre eux en suivent un
        // autre. Une reponse juste n'est notee juste que si chaque cas demarre seul.
        String code = """
                #include <dirent.h>
                #include <pthread.h>
                #include <stdio.h>
                #include <stdlib.h>
                #include <unistd.h>

                static void *dort(void *x) { (void) x; sleep(60); return 0; }

                static int autres_processus(void) {
                    DIR *d = opendir("/proc");
                    struct dirent *e;
                    char chemin[64], ligne[256];
                    int n = 0;
                    if (!d) return 0;
                    while ((e = readdir(d))) {
                        int pid = atoi(e->d_name);
                        if (pid <= 0 || pid == getpid()) continue;
                        snprintf(chemin, sizeof chemin, "/proc/%d/status", pid);
                        FILE *f = fopen(chemin, "r");
                        if (!f) continue;
                        while (fgets(ligne, sizeof ligne, f)) {
                            unsigned u;
                            if (sscanf(ligne, "Uid: %u", &u) == 1) {
                                if (u == getuid()) n++;
                                break;
                            }
                        }
                        fclose(f);
                    }
                    closedir(d);
                    return n;
                }

                int doubler(int n) {
                    int deja = autres_processus();
                    if (fork() == 0) {
                        for (int fd = 0; fd < 256; fd++) close(fd);
                        setsid();
                        pthread_t t;
                        pthread_create(&t, 0, dort, 0);
                        pthread_exit(0);
                    }
                    return deja ? 0 : n * 2;
                }
                """;
        List<TestResult> r = evaluator.evaluate("C", code, List.of(
                new TestCaseInput("un", "return doubler(1) == 2;", 1),
                new TestCaseInput("deux", "return doubler(2) == 4;", 1),
                new TestCaseInput("trois", "return doubler(3) == 6;", 1)), null);
        assertThat(r).extracting(TestResult::passed).containsExactly(true, true, true);
    }

    @Test
    void box_is_not_writable_by_submitted_code() {
        // /box est un tmpfs monte en 1777 : le code soumis pouvait y poser ce qu'il voulait, a
        // l'endroit que root parcourt entre deux cas. Le superviseur le passe en 0755 en mode
        // notation. Sonde directe, sans dependre d'aucune protection du noyau : la creation
        // doit echouer, et seule alors la reponse est juste.
        assertThat(note("C", "return doubler(5) == 10;", """
                #include <stdio.h>
                int doubler(int n) {
                    FILE *f = fopen("/box/sonde", "w");
                    if (f) { fclose(f); return 0; }
                    return n * 2;
                }
                """).passed()).isTrue();
    }

    // ───────── 1 bis. Les OBJETS : poignées, l'instance vit chez l'étudiant ─────────

    @Test
    void java_objects_by_handle() {
        // Le harnais écrit l'appel naturellement ; l'objet est construit DANS le processus de
        // l'étudiant et le noteur n'en manipule qu'une poignée. Champs privés compris : c'est du
        // code normal côté étudiant.
        String h = "return new Solution.Rectangle(3, 4).aire() == 12;";
        String oop = """
                public class Solution {
                    public static class Rectangle {
                        private final int largeur;
                        private final int hauteur;
                        public Rectangle(int l, int h) { largeur = l; hauteur = h; }
                        public int aire() { return largeur * hauteur; }
                    }
                    public static int doubler(int n) { return n * 2; }
                }
                """;
        assertThat(note("Java", h, oop).passed()).isTrue();
        assertThat(note("Java", h, oop.replace("largeur * hauteur", "0")).passed()).isFalse();
    }

    @Test
    void csharp_objects_by_handle() {
        String h = "return new Solution(3, 4).Aire() == 12;";
        String oop = """
                public class Solution {
                    private readonly int largeur;
                    private readonly int hauteur;
                    public Solution(int l, int h) { largeur = l; hauteur = h; }
                    public int Aire() { return largeur * hauteur; }
                    public static int Doubler(int n) { return n * 2; }
                }
                """;
        assertThat(note("C#", h, oop).passed()).isTrue();
        assertThat(note("C#", h, oop.replace("largeur * hauteur", "0")).passed()).isFalse();
    }

    @Test
    void go_objects_by_handle() {
        // Go n'a pas de constructeur : l'idiome est une fonction qui renvoie la structure, et
        // c'est elle qu'on proxifie.
        String h = "return NewRectangle(3, 4).Aire() == 12";
        String oop = """
                package main

                type Rectangle struct {
                \tlargeur int
                \thauteur int
                }

                func NewRectangle(l int, h int) Rectangle {
                \treturn Rectangle{largeur: l, hauteur: h}
                }

                func (r Rectangle) Aire() int { return r.largeur * r.hauteur }
                """;
        assertThat(note("Go", h, oop).passed()).isTrue();
        assertThat(note("Go", h, oop.replace("r.largeur * r.hauteur", "0")).passed()).isFalse();
    }

    @Test
    void rust_objects_by_handle() {
        String h = "Rectangle::new(3, 4).aire() == 12";
        String oop = """
                struct Rectangle {
                    largeur: i32,
                    hauteur: i32,
                }

                impl Rectangle {
                    fn new(l: i32, h: i32) -> Rectangle {
                        Rectangle { largeur: l, hauteur: h }
                    }

                    fn aire(&self) -> i32 {
                        self.largeur * self.hauteur
                    }
                }
                """;
        assertThat(note("Rust", h, oop).passed()).isTrue();
        assertThat(note("Rust", h, oop.replace("self.largeur * self.hauteur", "0"))
                .passed()).isFalse();
    }

    @Test
    void cpp_objects_by_handle() {
        String h = "return Rectangle(3, 4).aire() == 12;";
        // Constructeur à LISTE D'INITIALISATION : la forme du code de départ de la démo.
        String oop = """
                class Rectangle {
                    int largeur, hauteur;
                public:
                    Rectangle(int largeur, int hauteur) : largeur(largeur), hauteur(hauteur) {}
                    int aire() { return largeur * hauteur; }
                };
                """;
        assertThat(note("C++", h, oop).passed()).isTrue();
        assertThat(note("C++", h, oop.replace("largeur * hauteur", "0")).passed()).isFalse();
    }

    // ── Formes RÉELLES des questions POO de la démo (db/demo/V2_3) : ce sont elles qui
    //    décident si la fonctionnalité est utilisable, pas des exemples écrits pour le test.

    @Test
    void go_named_field_literal() {
        // Idiome Go d'une structure sans constructeur, et forme du harnais de la démo.
        String h = "r := Rectangle{largeur: 3, hauteur: 4}\nreturn r.aire() == 12";
        String oop = """
                package main

                type Rectangle struct {
                \tlargeur int
                \thauteur int
                }

                func (r Rectangle) aire() int { return r.largeur * r.hauteur }
                """;
        assertThat(note("Go", h, oop).passed()).isTrue();
        assertThat(note("Go", h, oop.replace("r.largeur * r.hauteur", "0")).passed()).isFalse();
    }

    @Test
    void rust_named_field_literal() {
        String h = "let r = Rectangle { largeur: 3, hauteur: 4 };\nr.aire() == 12";
        String oop = """
                struct Rectangle {
                    largeur: i32,
                    hauteur: i32,
                }

                impl Rectangle {
                    fn aire(&self) -> i32 {
                        self.largeur * self.hauteur
                    }
                }
                """;
        assertThat(note("Rust", h, oop).passed()).isTrue();
        assertThat(note("Rust", h, oop.replace("self.largeur * self.hauteur", "0"))
                .passed()).isFalse();
    }

    // Le serveur généré partage la portée du code soumis : ses locales (`id`, `args`, `valeur`,
    // `req`, `nom`…) masquaient une fonction soumise du même nom, et le programme de l'étudiant
    // ne compilait plus — une réponse juste notée 0. Seule une vraie compilation le voit : les
    // tests des générateurs comparent du texte.

    @Test
    void rust_function_named_like_a_server_local_is_graded() {
        String h = "premier(7) && id(3) == 3 && args(2) == 4 && cle(1) == 2 && a0(5) == 5";
        String code = """
                fn premier(n: i32) -> bool { n == 7 }
                fn id(n: i32) -> i32 { n }
                fn args(n: i32) -> i32 { n * 2 }
                fn cle(n: i32) -> i32 { n + 1 }
                fn a0(n: i32) -> i32 { n }
                """;
        TestResult r = note("Rust", h, code);
        assertThat(r.passed()).as(r.detail() == null ? "" : r.detail()).isTrue();
        assertThat(note("Rust", h, code.replace("n * 2", "0")).passed()).isFalse();
    }

    @Test
    void rust_field_named_like_a_server_local_is_graded() {
        String h = "let p = Point { id: 3, args: 4 };\np.somme() == 7";
        String code = """
                struct Point {
                    id: i32,
                    args: i32,
                }

                impl Point {
                    fn somme(&self) -> i32 {
                        self.id + self.args
                    }
                }
                """;
        TestResult r = note("Rust", h, code);
        assertThat(r.passed()).as(r.detail() == null ? "" : r.detail()).isTrue();
        assertThat(note("Rust", h, code.replace("self.id + self.args", "0")).passed()).isFalse();
    }

    @Test
    void go_function_named_like_a_server_local_is_graded() {
        String h = "return valeur(5) == 10 && req(1) == 2 && ligne(3) == 3 && rep(4) == 4";
        String code = """
                package main

                func valeur(n int) int { return n * 2 }
                func req(n int) int { return n + 1 }
                func ligne(n int) int { return n }
                func rep(n int) int { return n }
                """;
        TestResult r = note("Go", h, code);
        assertThat(r.passed()).as(r.detail() == null ? "" : r.detail()).isTrue();
        assertThat(note("Go", h, code.replace("n * 2", "0")).passed()).isFalse();
    }

    @Test
    void c_and_cpp_function_named_like_a_server_local_is_graded() {
        String h = "return id(5) == 5 && op(2) == 4 && nom(1) == 2 && a0(3) == 3;";
        String code = """
                int id(int x) { return x; }
                int op(int x) { return x * 2; }
                int nom(int x) { return x + 1; }
                int a0(int x) { return x; }
                """;
        for (String language : List.of("C", "C++")) {
            TestResult r = note(language, h, code);
            assertThat(r.passed()).as(language + " : " + (r.detail() == null ? "" : r.detail()))
                    .isTrue();
            assertThat(note(language, h, code.replace("x * 2", "0")).passed()).isFalse();
        }
    }

    // Balayage systématique des collisions de noms (#246) : chaque identifiant du code généré et
    // des bibliothèques qu'il importe, essayé comme fonction, fonction d'aide, variable, type,
    // méthode et champ soumis, par compilation réelle. Les cas ci-dessous sont un témoin par
    // famille de défauts trouvée ; la version fausse de chaque réponse doit rester fausse.

    private void gradedThenWrong(String language, String harness, String code, String right,
            String wrong) {
        TestResult r = note(language, harness, code);
        assertThat(r.passed()).as(language + " : " + (r.detail() == null ? "" : r.detail()))
                .isTrue();
        assertThat(note(language, harness, code.replace(right, wrong)).passed()).isFalse();
    }

    @Test
    void rust_constants_statics_and_prelude_aliases_do_not_reach_the_generated_code() {
        // Une `const id` ou un `static args` faisait d'un `let id = …` du serveur un MOTIF de
        // constante ; `type Result<T>` (idiome courant) remplaçait celui du prélude.
        gradedThenWrong("Rust", "doubler(5) == 10 && Point { i: 3, parts: 4 }.somme() == 7", """
                type Result<T> = std::result::Result<T, String>;
                const id: i32 = 4;
                static args: i32 = 1;
                const i: i32 = 0;

                fn doubler(n: i32) -> i32 { n * 2 }

                struct Point {
                    i: i32,
                    parts: i32,
                }

                impl Point {
                    fn somme(&self) -> i32 {
                        self.i + self.parts
                    }
                }
                """, "n * 2", "0");
    }

    @Test
    void rust_impl_written_on_one_line_is_graded() {
        gradedThenWrong("Rust", "(R { v: 3 }).get() == 3",
                "struct R { v: i32 }\nimpl R { fn get(&self) -> i32 { self.v } }\n",
                "self.v }", "0 }");
    }

    @Test
    void c_names_of_the_standard_library_are_ordinary_names_for_a_submission() {
        // Le serveur n'inclut plus aucun en-tête : une fonction d'aide `index`, `div` ou
        // `remove`, un `typedef … uint` et une macro `abs(x)` ne heurtent plus stdio/stdlib/string.
        gradedThenWrong("C", "return dist(-3) == 3 && moitie(8) == 4;", """
                #define abs(x) ((x) < 0 ? -(x) : (x))
                #define TRUE 1
                typedef unsigned int uint;
                int index(int x) { return x; }
                int div(int a, int b) { return a / b; }
                int remove(int x) { return x - 1; }
                int dist(int a) { return abs(index(a)); }
                int moitie(int a) { return div(a, 2); }
                """, "a / b", "0");
    }

    @Test
    void c_and_cpp_keyword_macros_do_not_reach_the_grader() {
        // #22 : quand le code soumis précédait le harnais dans le même programme, une macro sur un
        // mot-clé réécrivait le harnais. La réponse fausse ci-dessous (`n * 3`) passerait si l'une
        // de ces macros atteignait le noteur : `if` neutralisé, il ne reste que `doubler(0) == 0`,
        // vrai ; `return` détourné, il renvoie 1. Le noteur est un autre programme : la macro ne
        // touche que le programme soumis, ce que fixe la RAISON de chaque échec (sans elle, un
        // échec quelconque, du noteur compris, ferait passer ce test).
        String h = "if (doubler(5) != 10) return 0;\nreturn doubler(0) == 0;";
        for (String language : List.of("C", "C++")) {
            assertThat(note(language, h, "int doubler(int n) { return n * 2; }\n").passed())
                    .as(language + " : témoin juste").isTrue();
            // La macro ne détraque que la fonction SOUMISE : le serveur généré s'en débarrasse
            // (`#undef`, revue #246), répond normalement, et c'est le harnais du noteur, intact,
            // qui juge la réponse fausse. Atteint par la macro, il aurait renvoyé vrai.
            TestResult ret = note(language, h,
                    "#define return return 1 ||\nint doubler(int n) { return n * 3; }\n");
            assertThat(ret.passed()).as(language + " : return").isFalse();
            assertThat(ret.detail()).as(language + " : return").isEqualTo("Le harnais a renvoyé faux");
            TestResult cond = note(language, h,
                    "#define if(c) if (0)\nint doubler(int n) { return n * 3; }\n");
            assertThat(cond.passed()).as(language + " : if").isFalse();
            assertThat(cond.detail()).as(language + " : if").isEqualTo("Le harnais a renvoyé faux");
        }
    }

    @Test
    void cpp_helper_named_like_the_c_library_is_graded_not_refused() {
        gradedThenWrong("C++", "return dist(-3) == 3;", """
                int abs(int x) { return x < 0 ? -x : x; }
                int index(int x) { return x; }
                int dist(int a) { return abs(index(a)); }
                """, "-x : x", "0 : 0");
    }

    @Test
    void cpp_using_namespace_std_does_not_make_the_generated_call_ambiguous() {
        // `divides`, `plus`, `modulus`… sont des types de <functional> : avec `using namespace
        // std;`, l'appel nu du serveur était ambigu.
        gradedThenWrong("C++", "return divides(4) == 2 && plus(1) == 2;", """
                #include <algorithm>
                #include <functional>
                using namespace std;
                int divides(int a) { return a / 2; }
                int plus(int a) { return a + 1; }
                """, "a / 2", "0");
    }

    @Test
    void cpp_method_named_like_a_function_the_stub_calls_is_graded() {
        gradedThenWrong("C++", "return Rect(2).atoi() == 2 && Rect(5).snprintf() == 6;", """
                class Rect {
                    int v;
                public:
                    Rect(int a) : v(a) {}
                    int atoi() { return v; }
                    int snprintf() { return v + 1; }
                };
                """, "return v;", "return 0;");
    }

    @Test
    void c_submission_defining_a_symbol_the_server_links_to_is_refused_by_name() {
        TestResult r = note("C", "return doubler(5) == 10;", """
                int printf(int x) { return x; }
                int doubler(int n) { return n * 2; }
                """);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("réservé").contains("printf");
    }

    @Test
    void cpp_class_named_like_a_library_function_is_refused_by_name() {
        TestResult r = note("C++", "return remove(3).get() == 3;", """
                class remove { int v; public: remove(int a) : v(a) {} int get() { return v; } };
                """);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("réservé").contains("remove");
        // Classe d'aide que le harnais ne nomme pas : ni bouchon ni refus.
        gradedThenWrong("C++", "return via(3) == 3;", """
                class remove { int v; public: remove(int a) : v(a) {} int get() { return v; } };
                int via(int a) { return remove(a).get(); }
                """, "return v;", "return 0;");
    }

    @Test
    void go_package_declaration_hiding_a_predeclared_name_is_refused_by_name() {
        TestResult r = note("Go", "return doubler(5) == 10",
                "package main\n\nvar string = 3\n\nfunc doubler(n int) int { return n * 2 }\n");
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("réservé").contains("string");
        // Un nom prédéclaré dont le serveur ne se sert pas reste un nom ordinaire.
        gradedThenWrong("Go", "return doubler(5) == 10",
                "package main\n\nvar max = 10\n\nfunc doubler(n int) int { return n * 2 }\n",
                "n * 2", "0");
    }

    @Test
    void java_class_named_like_a_class_the_grader_uses_is_graded() {
        gradedThenWrong("Java", "return new PrintStream(3).get() == 3;", """
                class PrintStream {
                    int v;
                    PrintStream(int a) { v = a; }
                    int get() { return v; }
                }
                """, "return v;", "return 0;");
    }

    @Test
    void csharp_method_named_like_a_framework_class_is_graded() {
        // `Convert` : le nom le plus naturel d'un exercice de conversion.
        gradedThenWrong("C#", "return Solution.Convert(1.5) == 3.0 && Solution.System(2) == 3;", """
                class Solution {
                    public static double Convert(double c) { return c * 2; }
                    public static int System(int n) { return n + 1; }
                }
                """, "c * 2", "0");
    }

    @Test
    void csharp_class_named_like_a_framework_class_is_graded() {
        gradedThenWrong("C#", "return new Type(1).Get() == 2;", """
                class Type {
                    int v;
                    public Type(int a) { v = a; }
                    public int Get() { return v + 1; }
                }
                """, "v + 1", "0");
        gradedThenWrong("C#", "return Solution.Via(1) == 2;", """
                class Console {
                    public int v;
                    public Console(int a) { v = a; }
                    public int Get() { return v + 1; }
                }
                class Exception { }
                class Solution {
                    public static int Via(int x) { return new Console(x).Get(); }
                }
                """, "v + 1", "0");
    }

    @Test
    void rust_type_and_function_named_like_the_prelude_do_not_reach_the_grader_runtime() {
        // Le harnais NOMME `Vec` et `Ok` : leurs bouchons sont à la racine du noteur. Son runtime
        // (Vec::new(), Vec<char>, le motif `Ok(l)`) vit dans `mod moodit_rt`, hors de leur portée ;
        // à la racine, il ne compilait plus contre eux.
        gradedThenWrong("Rust", "doubler(5) == 10 && Ok(2) == 3 && Vec { x: 3, y: 4 }.norme() == 7",
                """
                struct Vec {
                    x: i32,
                    y: i32,
                }

                impl Vec {
                    fn norme(&self) -> i32 {
                        self.x + self.y
                    }
                }

                #[allow(non_snake_case)]
                fn Ok(n: i32) -> i32 { n + 1 }

                fn doubler(n: i32) -> i32 { n * 2 }
                """, "self.x + self.y", "0");
    }

    @Test
    void csharp_class_the_harness_names_like_a_class_the_grader_runtime_uses_is_graded() {
        // Le harnais NOMME `Console` : son bouchon est une classe du niveau global, qui l'emporte
        // sur `using System;`. Le runtime du noteur et le verdict (Console.Error, Console.Out)
        // vivent dans `namespace MooditRt`, où `using global::System` passe avant elle.
        gradedThenWrong("C#", "return new Console(1).Get() == 2;", """
                class Console {
                    int v;
                    public Console(int a) { v = a; }
                    public int Get() { return v + 1; }
                }
                """, "v + 1", "0");
    }

    @Test
    void cpp_class_named_like_a_standard_type_under_using_namespace_std_is_graded() {
        // Le serveur nomme la classe soumise `::pair` : avec `using namespace std;`, le nom nu
        // désignait à la fois la classe soumise et std::pair.
        gradedThenWrong("C++", "return pair(2, 3).somme() == 5;", """
                #include <utility>
                using namespace std;
                class pair {
                    int a, b;
                public:
                    pair(int x, int y) : a(x), b(y) {}
                    int somme() { return a + b; }
                };
                """, "return a + b;", "return 0;");
    }

    @Test
    void cpp_member_or_using_declaration_named_like_a_linked_symbol_is_graded() {
        // Une méthode `free` définie hors de sa classe et un `using std::printf;` ne définissent
        // aucun symbole de la libc : la réponse était refusée « nom réservé ».
        gradedThenWrong("C++", "return Pile(3).free() == 3 && doubler(5) == 10;", """
                #include <cstdio>
                #include <cstdlib>
                using std::printf;
                using std::free;
                class Pile {
                    int n;
                public:
                    Pile(int a) : n(a) {}
                    int free();
                };
                int Pile::free() { return n; }
                int doubler(int n) { return n * 2; }
                """, "return n;", "return 0;");
    }

    @Test
    void cpp_overload_of_a_linked_symbol_is_graded_and_the_real_symbol_stays_refused() {
        // Une surcharge (`free(Noeud *)`, `printf(int)`) porte un symbole décoré : elle ne
        // remplace pas la fonction de la libc à laquelle le serveur est lié.
        gradedThenWrong("C++", "return valeur(4) == 4 && suivant(1) == 2;", """
                #include <cstdio>
                #include <cstdlib>
                struct Noeud { int v; };
                int free(Noeud *n) { return n->v; }
                int printf(int x) { return x + 1; }
                int valeur(int a) { Noeud n; n.v = a; return free(&n); }
                int suivant(int a) { return printf(a); }
                """, "return n->v;", "return 0;");
        // La signature de la libc, elle, reprend son symbole : refus nommé.
        TestResult r = note("C++", "return doubler(5) == 10;", """
                #include <cstdlib>
                void free(void *p) { }
                int doubler(int n) { return n * 2; }
                """);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains("réservé").contains("free");
    }

    @Test
    void c_symbol_the_server_links_to_is_refused_by_name_however_it_is_written() {
        // Écritures que le contrôle textuel ne reconnaît pas : le binaire, lui, porte le symbole.
        // Type de retour sur sa propre ligne (C) :
        TestResult c = note("C", "return doubler(5) == 10;", """
                int
                printf(const char *f, ...) { return 0; }
                int doubler(int n) { return n * 2; }
                """);
        assertThat(c.passed()).isFalse();
        assertThat(c.detail()).contains("réservé").contains("printf");
        // Paramètre écrit par un alias de type : même signature que la libc, pas une surcharge.
        TestResult alias = note("C++", "return doubler(5) == 10;", """
                #include <cstdlib>
                typedef void *adresse;
                void free(adresse p) noexcept { }
                int doubler(int n) { return n * 2; }
                """);
        assertThat(alias.passed()).isFalse();
        assertThat(alias.detail()).contains("réservé").contains("free");
        // Bloc `extern "C"` :
        TestResult bloc = note("C++", "return doubler(5) == 10;", """
                extern "C" {
                void *malloc(unsigned long n) { return 0; }
                }
                int doubler(int n) { return n * 2; }
                """);
        assertThat(bloc.passed()).isFalse();
        assertThat(bloc.detail()).contains("réservé").contains("malloc");
        // Fonction versionnée par directive d'assembleur : `T free@@GLIBC_2.2.5` dans le binaire.
        TestResult versionnee = note("C", "return doubler(5) == 10;", """
                void mon_free(void *p) { }
                __asm__(".symver mon_free,free@@GLIBC_2.2.5");
                int doubler(int n) { return n * 2; }
                """);
        assertThat(versionnee.passed()).isFalse();
        assertThat(versionnee.detail()).contains("réservé").contains("free");
        // Une VARIABLE n'est jamais décorée, en C comme en C++ :
        for (String language : List.of("C", "C++")) {
            TestResult variable = note(language, "return doubler(5) == 10;", """
                    int stdin = 3;
                    int free;
                    int doubler(int n) { return n * 2; }
                    """);
            assertThat(variable.passed()).as(language).isFalse();
            assertThat(variable.detail()).as(language).contains("réservé").contains("free")
                    .contains("stdin");
        }
    }

    @Test
    void c_names_that_define_no_linked_symbol_are_graded() {
        // Le contrôle lit le binaire : ce qui n'y définit aucun symbole de la libc est du code
        // ordinaire. Une statique que rien n'appelle n'y figure pas (C) ; un membre de classe y
        // est décoré, même écrit avec une espace avant `::` (C++).
        gradedThenWrong("C", "return doubler(5) == 10;", """
                static int malloc(int x) { return x; }
                static void *realloc(void *p, unsigned long n) { return 0; }
                int doubler(int n) { return n * 2; }
                """, "n * 2", "0");
        gradedThenWrong("C++", "return Pile(3).free() == 3 && doubler(5) == 10;", """
                class Pile {
                public:
                    static int stdout;
                    int n;
                    Pile(int a) : n(a) {}
                    int free();
                };
                int Pile ::stdout = 7;
                int Pile ::free() { return n + stdout - 7; }
                int doubler(int n) { return n * 2; }
                """, "n * 2", "0");
    }

    @Test
    void java_public_class_is_the_object() {
        // La classe publique s'appelle Rectangle : c'est elle qu'on instancie, et il n'y a
        // AUCUNE méthode statique. Exiger une statique refusait cette question.
        String h = "return new Rectangle(3, 4).aire() == 12;";
        String oop = """
                public class Rectangle {
                    private int largeur, hauteur;

                    public Rectangle(int largeur, int hauteur) {
                        this.largeur = largeur;
                        this.hauteur = hauteur;
                    }

                    public int aire() {
                        return largeur * hauteur;
                    }
                }
                """;
        assertThat(note("Java", h, oop).passed()).isTrue();
        assertThat(note("Java", h, oop.replace("return largeur * hauteur;", "return 0;"))
                .passed()).isFalse();
    }

    @Test
    void csharp_without_static_method() {
        String h = "return new Rectangle(3, 4).aire() == 12;";
        String oop = """
                using System;

                class Rectangle {
                    int largeur, hauteur;
                    public Rectangle(int largeur, int hauteur) {
                        this.largeur = largeur;
                        this.hauteur = hauteur;
                    }
                    public int aire() { return largeur * hauteur; }
                }

                class Program {
                    static void Main() {
                        Console.WriteLine(new Rectangle(3, 4).aire());
                    }
                }
                """;
        assertThat(note("C#", h, oop).passed()).isTrue();
        assertThat(note("C#", h, oop.replace("return largeur * hauteur;", "return 0;"))
                .passed()).isFalse();
    }

    // ── Types de retour et idiomes que la première version ne savait pas générer. Chacun de ces
    //    cas rendait « Échec de compilation » à un étudiant dont le code était juste.

    @Test
    void java_all_marshalable_return_types() {
        // `long`, `double` et `boolean` sont des MOTS RÉSERVÉS : le nom de la méthode RPC ne peut
        // pas être dérivé du type. Seuls int et String compilaient.
        assertThat(note("Java", "return Solution.moitie(7) == 3L;",
                "public class Solution { public static long moitie(int n) { return n / 2; } }")
                .passed()).isTrue();
        assertThat(note("Java", "return Math.abs(Solution.aire(3, 4) - 12.0) < 1e-9;",
                "public class Solution { public static double aire(int l, int h)"
                        + " { return l * (double) h; } }").passed()).isTrue();
        assertThat(note("Java", "return Solution.pair(4);",
                "public class Solution { public static boolean pair(int n)"
                        + " { return n % 2 == 0; } }").passed()).isTrue();
        assertThat(note("Java", "return Solution.crie(\"bon\").equals(\"BON\");",
                "public class Solution { public static String crie(String s)"
                        + " { return s.toUpperCase(); } }").passed()).isTrue();
    }

    @Test
    void java_string_containing_protocol_separator() {
        // Un `]`, un `\"` ou une barre oblique inverse dans la valeur cassait l'analyse : la
        // réponse juste était notée FAUSSE. Les chaînes voyagent donc en hexadécimal.
        String code = "public class Solution { public static String copie(String s)"
                + " { return s; } }";
        assertThat(note("Java", "return Solution.copie(\"ab]cd\").equals(\"ab]cd\");", code)
                .passed()).isTrue();
        assertThat(note("Java", "return Solution.copie(\"a\\\"b\\\\c|d\").equals(\"a\\\"b\\\\c|d\");",
                code).passed()).isTrue();
    }

    @Test
    void rust_method_with_parameters() {
        // Les arguments n'étaient ni lus ni transmis côté étudiant : rustc refusait son programme.
        String h = "let c = Compteur { valeur: 10 };\nc.plus(5) == 15";
        String oop = """
                struct Compteur {
                    valeur: i32,
                }

                impl Compteur {
                    fn plus(&self, n: i32) -> i32 {
                        self.valeur + n
                    }
                }
                """;
        assertThat(note("Rust", h, oop).passed()).isTrue();
        assertThat(note("Rust", h, oop.replace("self.valeur + n", "0")).passed()).isFalse();
    }

    @Test
    void go_pointer_receiver_method() {
        // L'idiome le plus répandu. L'aiguillage appelait la méthode sur le résultat d'une
        // assertion de type, qui n'est pas adressable : le programme ne compilait pas.
        String h = "c := NewCompteur(10)\nreturn c.Plus(5) == 15";
        String oop = """
                package main

                type Compteur struct {
                \tvaleur int
                }

                func NewCompteur(v int) *Compteur {
                \treturn &Compteur{valeur: v}
                }

                func (c *Compteur) Plus(n int) int { return c.valeur + n }
                """;
        assertThat(note("Go", h, oop).passed()).isTrue();
        assertThat(note("Go", h, oop.replace("c.valeur + n", "0")).passed()).isFalse();
    }

    @Test
    void strings_and_floats_over_text_protocols() {
        // `%g` tronquait un double à 6 chiffres significatifs, dans les deux sens, et une chaîne
        // contenant « | » décalait tout l'appel : réponse juste notée fausse.
        assertThat(note("C", "return doubler(3.14159265) > 6.2831852;",
                "double doubler(double x) { return x * 2; }").passed()).isTrue();
        assertThat(note("C#", "return Solution.Copie(\"a|b\") == \"a|b\";",
                "class Solution { public static string Copie(string s) { return s; } }")
                .passed()).isTrue();
        assertThat(note("Rust", "copie(String::from(\"a|b\")) == \"a|b\"",
                "fn copie(s: String) -> String { s }").passed()).isTrue();
    }

    @Test
    void grader_inclusion_at_compile_time_refused() {
        // Le compilateur OBEIT au texte soumis : il sait embarquer un fichier dans le binaire
        // (include_str! en Rust, .incbin via asm en C). Compile par root a cote du noteur,
        // c'etait le harnais ET le nonce dans le binaire note. La compilation etudiante tourne
        // sous SON UID dans un chantier qui ne contient que son code : l'inclusion echoue, le
        // cas est refuse, rien ne fuit.
        // Le chemin vise le noteur LA OU IL EST (`../`, a cote du chantier etu_build) : avec le
        // nom nu, le fichier n'existait pour personne et le test passait meme compile par root.
        // Chaque sonde a son TEMOIN, identique sans l'inclusion, qui doit reussir.
        String rust = """
                const G: &str = include_str!("../noteur.rs");
                fn copie(n: i32) -> i32 { if G.is_empty() { n } else { n } }
                """;
        assertThat(note("Rust", "copie(1) == 1", rust).passed()).isFalse();
        assertThat(note("Rust", "copie(1) == 1",
                rust.replace("include_str!(\"../noteur.rs\")", "\"\"")).passed()).isTrue();
        String c = """
                __asm__(".section .rodata\\n g: .incbin \\\"../noteur.c\\\"\\n .previous");
                int doubler(int n) { return n * 2; }
                """;
        assertThat(note("C", "return doubler(2) == 4;", c).passed()).isFalse();
        assertThat(note("C", "return doubler(2) == 4;",
                c.replace(" g: .incbin \\\"../noteur.c\\\"\\n", "")).passed()).isTrue();
    }

    @Test
    void cgo_stays_disabled_for_student_build() {
        // CGO_ENABLED=0 du Dockerfile ne survivait PAS au env= de Popen : cgo redevenait actif
        // et son preambule C savait inclure ../noteur/noteur.go. La variable est posee dans
        // l'environnement de build lui-meme ; un import "C" doit donc echouer a compiler.
        // Avec sa clause `package` : sans elle le fichier ne compilait dans aucun cas, cgo actif
        // ou non, et le test ne prouvait rien. TEMOIN : le meme code sans l'import reussit.
        String go = """
                package main

                import "C"

                func doubler(n int) int { return n * 2 }
                """;
        assertThat(note("Go", "return doubler(2) == 4", go).passed()).isFalse();
        assertThat(note("Go", "return doubler(2) == 4",
                go.replace("import \"C\"\n", "")).passed()).isTrue();
    }

    // ──────────────────── 2. Forger le résultat : plus aucun canal ────────────────────

    @Test
    void java_forged_answer_and_token_fail() {
        // Devancer la réponse RPC (dès le chargement de la classe, puis à l'appel) et rendre
        // une valeur fausse : si une réponse forgée était prise pour la vraie, le cas passerait.
        // (Le nonce n'est pas dans la mémoire du code soumis — autre processus, autre UID — :
        // un parcours de /proc/self/mem qui ne pouvait rien changer au résultat a été retiré.)
        TestResult r = note("Java", "return Solution.doubler(5) == 10;", """
                public class Solution {
                    static {
                        System.out.println("{\\"ok\\":true,\\"value\\":10}");
                    }

                    public static int doubler(int n) {
                        System.out.println("{\\"ok\\":true,\\"value\\":10}");
                        return 0;
                    }
                }
                """);
        assertThat(r.passed()).isFalse();
        // Le refus doit venir du HARNAIS qui a tourné et rendu faux — pas d'un code d'attaque
        // qui ne compile plus, d'un serveur mort ou d'une erreur du noteur : sans cette
        // assertion, le test resterait vert en ayant cessé de mesurer la forge.
        assertThat(r.detail() == null ? "" : r.detail()).contains(HARNESS_FALSE);
    }

    @Test
    void c_printf_interposition_fails() {
        // Le résiduel historique de C/C++ : le code étudiant détournait printf pour capturer la
        // sortie du mini-framework — jeton compris — puis forgeait le verdict. Le harnais n'est
        // plus dans son unité de compilation : il n'y a plus rien à capturer.
        TestResult r = note("C", "return doubler(5) == 10;", """
                #include <stdio.h>
                #include <stdlib.h>

                static int moodit_vu = 0;
                #define printf(...) (moodit_vu = 1, fprintf(stdout, __VA_ARGS__))

                int doubler(int n) {
                    printf("peu importe\\n");
                    /* On tente aussi de devancer la reponse et de sortir en succes. */
                    fprintf(stdout, "deadbeef|ok|10\\n");
                    fflush(stdout);
                    return 0;
                }
                """);
        assertThat(r.passed()).isFalse();
        // Le refus doit venir du HARNAIS, pas d'un code d'attaque qui ne compile plus :
        // sans cette assertion, le test resterait vert en ayant cessé de mesurer la forge.
        assertThat(r.detail()).contains(HARNESS_FALSE);
    }

    @Test
    void go_answering_early_fails() {
        TestResult r = note("Go", "return doubler(5) == 10", """
                package main

                import "fmt"

                func init() {
                    // Devancer la question : sans identifiant par appel, le noteur consommait
                    // cette ligne comme reponse.
                    fmt.Println("{\\"ok\\":true,\\"value\\":10}")
                }

                func doubler(n int) int {
                    fmt.Println("{\\"ok\\":true,\\"value\\":10}")
                    return 0
                }
                """);
        assertThat(r.passed()).isFalse();
        // Le refus doit venir du HARNAIS, pas d'un code d'attaque qui ne compile plus :
        // sans cette assertion, le test resterait vert en ayant cessé de mesurer la forge.
        assertThat(r.detail()).contains(HARNESS_FALSE);
    }

    // Réponse DEVANCÉE au format du protocole (« identifiant|ok|valeur »), écrite sur la sortie
    // du serveur avant et pendant l'appel, SANS toucher au descripteur : la ligne atteint donc
    // bien le noteur, qui ne doit retenir que celle qui porte l'identifiant de SON appel. Jumeaux
    // de go_answering_early_fails pour C#, Rust et C++, où rien ne mesurait ce contrôle de bout en
    // bout (csharp_dup2_and_reflection_fail coupe son propre canal : sa forge n'arrive jamais).

    @Test
    void csharp_answering_early_fails() {
        TestResult r = note("C#", "return Solution.Doubler(5) == 10;", """
                using System;

                public class Solution {
                    static Solution() {
                        Console.Out.WriteLine("deadbeef|ok|10");
                        Console.Out.Flush();
                    }

                    public static int Doubler(int n) {
                        Console.Out.WriteLine("deadbeef|ok|10");
                        Console.Out.WriteLine("|ok|10");
                        Console.Out.Flush();
                        return 0;
                    }
                }
                """);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains(HARNESS_FALSE);
    }

    @Test
    void rust_answering_early_fails() {
        TestResult r = note("Rust", "doubler(5) == 10", """
                use std::io::Write;

                pub fn doubler(_n: i32) -> i32 {
                    println!("deadbeef|ok|10");
                    println!("|ok|10");
                    std::io::stdout().flush().unwrap();
                    0
                }
                """);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains(HARNESS_FALSE);
    }

    @Test
    void cpp_answering_early_fails() {
        TestResult r = note("C++", "return doubler(5) == 10;", """
                #include <cstdio>

                // Constructeur d'un objet global : il tourne AVANT le main du serveur.
                struct Avance {
                    Avance() { std::printf("deadbeef|ok|10\\n"); std::fflush(stdout); }
                };
                static Avance avance;

                int doubler(int n) {
                    std::printf("deadbeef|ok|10\\n|ok|10\\n");
                    std::fflush(stdout);
                    return 0;
                }
                """);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains(HARNESS_FALSE);
    }

    @Test
    void csharp_dup2_cuts_only_its_own_answer_channel() {
        // mono autorise l'appel natif : le code soumis détourne son descripteur 1 vers stderr,
        // écrit une réponse forgée et fouille l'assemblage par réflexion. Le noteur est ailleurs,
        // sous un autre UID : le détournement ne coupe que le canal de réponse de l'étudiant
        // lui-même, et l'appel est refusé — jamais une réponse forgée acceptée. (La forge par
        // réponse devancée sur le canal intact est mesurée par csharp_answering_early_fails.)
        TestResult r = note("C#", "return Solution.Doubler(5) == 10;", """
                using System;
                using System.Runtime.InteropServices;

                public class Solution {
                    [DllImport("libc")] static extern int dup2(int o, int n);

                    public static int Doubler(int n) {
                        try {
                            dup2(2, 1);
                            Console.Out.WriteLine("deadbeef|ok|10");
                            Console.Out.Flush();
                            foreach (var t in typeof(Solution).Assembly.GetTypes()) {
                                Console.Error.WriteLine(t.FullName);
                            }
                        } catch (Exception) { }
                        return 0;
                    }
                }
                """);
        assertThat(r.passed()).isFalse();
        // La raison PRÉCISE : le processus soumis, privé de son canal, ne répond plus. Une
        // compilation échouée ou une erreur du noteur ne la donnent pas.
        assertThat(r.detail() == null ? "" : r.detail()).contains("processus etudiant termine");
    }

    // ────────────── 3. Le harnais du prof : ni lisible, ni modifiable ──────────────

    /**
     * Sonde Java du harnais : parcourt TOUT {@code /box} sans s'arrêter au premier refus, cherche
     * {@code needle} dans chaque fichier lisible, et tente d'ouvrir en écriture chaque fichier qui
     * n'appartient pas au code soumis. {@code verdict} est l'expression Java qui décide de la
     * réponse, sur {@code vu} (texte trouvé), {@code ecrit} (écriture obtenue) et {@code refus}
     * (accès refusés rencontrés).
     *
     * <p>L'ancienne sonde ({@code Files.walk}) levait au PREMIER dossier illisible, l'exception
     * était avalée, et elle rendait 0 sans avoir lu ni écrit un seul fichier : le test passait
     * quelle que soit la protection du harnais. Deux précautions de plus : le texte cherché est
     * écrit À L'ENVERS dans le source (sinon la sonde se trouve elle-même dans son propre
     * {@code .class}), et l'écriture est tentée en ajout de zéro octet (rien n'est abîmé).
     */
    private static String javaHarnessProbe(String needle, String verdict) {
        String reversed = new StringBuilder(needle).reverse().toString();
        return """
                import java.io.IOException;
                import java.nio.charset.StandardCharsets;
                import java.nio.file.FileVisitResult;
                import java.nio.file.Files;
                import java.nio.file.Path;
                import java.nio.file.Paths;
                import java.nio.file.SimpleFileVisitor;
                import java.nio.file.StandardOpenOption;
                import java.nio.file.attribute.BasicFileAttributes;

                public class Solution {
                    static final String MARQUEUR = "sonde-vivante-moodit";
                    static boolean vu = false;
                    static boolean ecrit = false;
                    static int refus = 0;

                    public static int doubler(int n) {
                        final String aiguille = new StringBuilder("%s").reverse().toString();
                        Object proprietaire = null;
                        try {
                            proprietaire = Files.getOwner(Paths.get("/proc/self"));
                        } catch (Exception ignore) { }
                        final Object moi = proprietaire;
                        try {
                            Files.walkFileTree(Paths.get("/box"), new SimpleFileVisitor<Path>() {
                                @Override
                                public FileVisitResult visitFile(Path p, BasicFileAttributes a) {
                                    if (!a.isRegularFile()) { return FileVisitResult.CONTINUE; }
                                    try {
                                        String t = new String(Files.readAllBytes(p),
                                                StandardCharsets.ISO_8859_1);
                                        if (t.contains(aiguille)) { vu = true; }
                                    } catch (Exception e) { refus++; }
                                    try {
                                        if (moi != null && !Files.getOwner(p).equals(moi)) {
                                            Files.newOutputStream(p, StandardOpenOption.APPEND)
                                                    .close();
                                            ecrit = true;
                                        }
                                    } catch (Exception e) { refus++; }
                                    return FileVisitResult.CONTINUE;
                                }

                                @Override
                                public FileVisitResult visitFileFailed(Path p, IOException e) {
                                    refus++;
                                    return FileVisitResult.CONTINUE;
                                }
                            });
                        } catch (Exception ignore) { }
                        return (%s) ? 10 : MARQUEUR.length() * 0;
                    }
                }
                """.formatted(reversed, verdict);
    }

    @Test
    void java_harness_unreachable_and_immutable() {
        String harness = "return Solution.doubler(5) == 10;";
        // TÉMOIN : la même sonde doit retrouver un texte qu'elle PEUT lire (son propre marqueur,
        // dans son .class) ET avoir essuyé des refus sans s'arrêter. Sans lui, une sonde qui ne
        // parcourt rien — le défaut de l'ancienne — rendait le test vert à vide.
        TestResult alive = note("Java", harness,
                javaHarnessProbe("sonde-vivante-moodit", "vu && refus > 0"));
        assertThat(alive.passed())
                .withFailMessage("la sonde doit lire ses propres fichiers et franchir les refus, "
                        + "sinon elle ne prouve rien : %s", alive)
                .isTrue();

        // La sonde, cette fois sur le texte du HARNAIS, et sur tout fichier qui n'est pas à elle.
        TestResult r = note("Java", harness, javaHarnessProbe("doubler(5) == 10", "vu || ecrit"));
        assertThat(r.passed())
                .as("le harnais ne doit être ni lisible ni modifiable depuis le code noté")
                .isFalse();
        // Le refus vient du HARNAIS, qui a tourné et reçu 0 : pas d'une sonde qui ne compile plus.
        assertThat(r.detail()).contains(HARNESS_FALSE);
    }

    @Test
    void c_harness_unreachable() {
        // La sonde cherche le texte du harnais dans tout fichier qui N'APPARTIENT PAS à son UID :
        // le harnais et le source du noteur (`noteur.c`, à l'UID du noteur, harnais et nonce
        // compris), job.json et les sources à root. Exclure son propre UID évite que la sonde ne
        // se matche ELLE-MEME — la chaîne recherchée figure dans son propre source et son binaire.
        // `-user root` seul ne regardait jamais `noteur.c` : un `noteur.c` laissé lisible n'aurait
        // pas fait échouer le test. Sous -std=gnu17, popen compile : si le harnais était lisible,
        // ceci le trouverait. Il ne l'est pas.
        TestResult r = note("C", "return doubler(5) == 10;", """
                #include <stdio.h>
                #include <string.h>

                int doubler(int n) {
                    FILE *p = popen("find /box -type f ! -uid $(id -u) -exec grep -l 'doubler(5)' {} + "
                                    "2>/dev/null | head -1", "r");
                    char ligne[512];
                    int vu = 0;
                    if (p) {
                        if (fgets(ligne, sizeof ligne, p) && strlen(ligne) > 1) { vu = 1; }
                        pclose(p);
                    }
                    return vu ? 10 : 0;
                }
                """);
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).contains(HARNESS_FALSE);

        // TÉMOIN : la même commande SANS le filtre d'UID trouve le texte dans les fichiers de
        // l'étudiant (son source le contient). Elle prouve que popen, find et grep tournent dans
        // le conteneur — sans quoi la sonde ci-dessus rendrait 0 pour une tout autre raison.
        TestResult alive = note("C", "return doubler(5) == 10;", """
                #include <stdio.h>
                #include <string.h>

                int doubler(int n) {
                    FILE *p = popen("find /box -type f -exec grep -l 'doubler(5)' {} + "
                                    "2>/dev/null | head -1", "r");
                    char ligne[512];
                    int vu = 0;
                    if (p) {
                        if (fgets(ligne, sizeof ligne, p) && strlen(ligne) > 1) { vu = 1; }
                        pclose(p);
                    }
                    return vu ? 10 : 0;
                }
                """);
        assertThat(alive.passed())
                .withFailMessage("le témoin doit trouver son propre source, sinon la sonde ne "
                        + "prouve rien : %s", alive)
                .isTrue();
    }

    // ───────────────────────── 4. Pas de fausse accusation ─────────────────────────

    @Test
    void honest_chatty_code_still_passes() {
        // Un étudiant qui imprime beaucoup, sur la sortie comme sur l'erreur, ne doit pas être
        // pénalisé : sa sortie n'est pas le canal de verdict (le nonce part du NOTEUR).
        TestResult r = note("Java", "return Solution.doubler(5) == 10;", """
                public class Solution {
                    public static int doubler(int n) {
                        System.out.println("je calcule " + n);
                        System.err.println("trace");
                        return n * 2;
                    }

                    public static void main(String[] args) {
                        System.out.println(doubler(21));
                        System.out.close();
                    }
                }
                """);
        assertThat(r.passed()).isTrue();
        assertThat(r.detail() == null ? "" : r.detail()).doesNotContain("⚠");
    }

    @Test
    void closing_stdout_in_graded_function_fails_cleanly() {
        // LIMITE ASSUMÉE, documentée dans docker/runners/README.md (« Contrat du canal de
        // réponse »). Fermer sa sortie standard DANS LA FONCTION NOTÉE détruit le canal sur
        // lequel le processus de l'étudiant répond : le cas ne peut pas être noté. Ce qui compte,
        // c'est que l'échec soit NET et explicite — pas un temps limite consommé en silence, et
        // pas une accusation de triche.
        //
        // Le test voisin fermait le flux dans `main`, qui n'est JAMAIS appelé sur ce chemin
        // (c'est le serveur généré qui tourne et invoque la méthode) : il donnait l'illusion de
        // couvrir cet idiome sans jamais l'exercer.
        TestResult r = note("Java", "return Solution.doubler(5) == 10;", """
                public class Solution {
                    public static int doubler(int n) {
                        System.out.close();
                        return n * 2;
                    }
                }
                """);
        assertThat(r.passed()).isFalse();
        // La raison PRÉCISE (et non un échec quelconque, de compilation par exemple) : le
        // processus de l'étudiant, privé de son canal de réponse, ne répond plus.
        assertThat(r.detail()).isNotNull()
                .contains("processus etudiant termine")
                .doesNotContain("temps limite")
                .doesNotContain("⚠");
    }

    @Test
    void idioms_and_values_the_review_found_uncovered() {
        // 1. C# : un constructeur prenant UN SEUL int — `new Compteur(0)`, l'idiome le plus
        //    courant — collisionnait avec le constructeur « à poignée » du bouchon. Le noteur ne
        //    compilait plus et la question rendait 0 sans diagnostic.
        assertThat(note("C#", "return new Compteur(10).Plus(5) == 15;", """
                class Compteur {
                    int valeur;
                    public Compteur(int depart) { valeur = depart; }
                    public int Plus(int n) { return valeur + n; }
                }
                """).passed()).isTrue();

        // 2. Rust : un champ String en capture de champs partait en clair alors que l'autre côté
        //    le décodait — une valeur commençant par « H » revenait mutilée.
        assertThat(note("Rust", "let p = Personne { nom: String::from(\"Hugo\"), age: 7 };\n"
                + "p.carte() == \"Hugo:7\"", """
                struct Personne {
                    nom: String,
                    age: i32,
                }

                impl Personne {
                    fn carte(&self) -> String {
                        format!("{}:{}", self.nom, self.age)
                    }
                }
                """).passed()).isTrue();

        // 3. Go : tout entier traversait un float64 (JSON), donc perdait des unités au-delà
        //    de 2^53. Une somme de grands nombres revenait fausse.
        assertThat(note("Go", "return somme(9007199254740993, 2) == 9007199254740995",
                "package main\n\nfunc somme(a int64, b int64) int64 { return a + b }\n")
                .passed()).isTrue();
    }

    @Test
    void rust_associated_or_nested_function_does_not_break_compilation() {
        // Une `fn` dans un `impl`, ou imbriquée dans une autre fonction, n'est pas appelable au
        // niveau module : l'aiguillage généré la citait quand même et le programme de l'étudiant
        // ne compilait plus. Il recevait 0 avec une erreur de compilation qui n'était pas la
        // sienne — le même défaut qu'en C++ avec les méthodes de classe.
        TestResult r = note("Rust", "doubler(5) == 10", """
                struct Aide {
                    facteur: i32,
                }

                impl Aide {
                    fn facteur_par_defaut() -> i32 { 2 }
                }

                fn doubler(n: i32) -> i32 {
                    fn multiplie(a: i32, b: i32) -> i32 { a * b }
                    multiplie(n, Aide::facteur_par_defaut())
                }
                """);
        assertThat(r.passed()).as(r.detail() == null ? "" : r.detail()).isTrue();
    }

    @Test
    void rust_mutating_method_not_wrongly_graded() {
        // En capture de champs, l'objet est reconstruit à chaque appel : une méthode `&mut self`
        // verrait sa modification perdue EN SILENCE. Le type n'est donc pas proxifié de cette
        // façon — le harnais ne compile pas et le prof le voit, plutôt qu'un faux verdict.
        TestResult r = note("Rust", "let mut c = Compteur { valeur: 0 };\nc.ajoute(5) == 5", """
                struct Compteur {
                    valeur: i32,
                }

                impl Compteur {
                    fn ajoute(&mut self, n: i32) -> i32 {
                        self.valeur += n;
                        self.valeur
                    }
                }
                """);
        assertThat(r.passed()).isFalse();
        // Et le motif désigne le bon fautif : le harnais, pas une accusation de triche.
        assertThat(r.detail() == null ? "" : r.detail()).doesNotContain("⚠");
    }

    @Test
    void java_submitted_code_exception_gives_its_cause_not_a_timeout() {
        // La réponse d'erreur du serveur ne portait pas l'identifiant de l'appel : le noteur ne
        // la consommait jamais, les deux processus s'attendaient, et le cas rendait « Interrompu
        // (temps limite dépassé) » au bout de son mur au lieu du vrai motif.
        TestResult r = note("Java", "return Solution.divise(1, 0) == 0;",
                "public class Solution { public static int divise(int a, int b)"
                        + " { return a / b; } }");
        assertThat(r.passed()).isFalse();
        assertThat(r.detail()).isNotNull()
                .doesNotContain("temps limite")
                .contains("harnais");
    }

    @Test
    void output_without_trailing_newline_does_not_block_the_pair() {
        // Le stdout du code noté EST le canal de réponse et il partage son tampon : une dernière
        // écriture sans saut de ligne se collait au début de la ligne de réponse, qui n'était
        // alors plus reconnue. Le couple s'attendait, et une réponse JUSTE était notée
        // « Interrompu (temps limite dépassé) » après avoir brûlé tout son temps.
        record CaseSpec(String lang, String harnessCode, String code) { }
        List<CaseSpec> caseInput = List.of(
                new CaseSpec("Java", "return Solution.doubler(5) == 10;", """
                        public class Solution {
                            public static int doubler(int n) {
                                System.out.print("sans saut de ligne");
                                return n * 2;
                            }
                        }
                        """),
                new CaseSpec("Rust", "doubler(5) == 10", """
                        fn doubler(n: i32) -> i32 {
                            print!("sans saut de ligne");
                            n * 2
                        }
                        """),
                new CaseSpec("Go", "return doubler(5) == 10", """
                        package main

                        import "fmt"

                        func doubler(n int) int {
                        \tfmt.Print("sans saut de ligne")
                        \treturn n * 2
                        }
                        """),
                new CaseSpec("C", "return doubler(5) == 10;", """
                        #include <stdio.h>

                        int doubler(int n) {
                            printf("sans saut de ligne");
                            return n * 2;
                        }
                        """),
                new CaseSpec("C++", "return doubler(5) == 10;", """
                        #include <iostream>

                        int doubler(int n) {
                            std::cout << "sans saut de ligne";
                            return n * 2;
                        }
                        """),
                new CaseSpec("C#", "return Solution.doubler(5) == 10;", """
                        using System;

                        class Solution {
                            public static int doubler(int n) {
                                Console.Write("sans saut de ligne");
                                return n * 2;
                            }
                        }
                        """));
        for (CaseSpec c : caseInput) {
            TestResult r = note(c.lang(), c.harnessCode(), c.code());
            assertThat(r.passed())
                    .as("sortie non terminée en " + c.lang() + " : "
                            + (r.detail() == null ? "" : r.detail()))
                    .isTrue();
        }
    }

    @Test
    void teacher_path_starting_from_defaults() {
        // Code de départ de la base (V2), complété par l'étudiant, noté par le GABARIT de harnais
        // de la base (V5) : c'est ce que vit un prof qui ne touche à rien dans l'éditeur. Rien ne
        // le vérifiait, et le gabarit C# y appelait une méthode qui n'existe pas.
        record CaseSpec(String lang, String harnessCode, String code) { }
        List<CaseSpec> caseInput = List.of(
                new CaseSpec("Java", "return Solution.solution() == 42;", """
                        // Sandbox : bibliothèque standard Java (JDK, aucun réseau).
                        public class Solution {
                            public static int solution() {
                                return 42;
                            }

                            public static void main(String[] args) {
                                System.out.println(solution());
                            }
                        }
                        """),
                new CaseSpec("C#", "return Solution.solution() == 42;", """
                        // Sandbox : bibliothèque standard .NET/Mono (aucun réseau).
                        using System;

                        class Solution {
                            public static int solution() {
                                return 42;
                            }

                            public static void Main() {
                                Console.WriteLine(solution());
                            }
                        }
                        """),
                new CaseSpec("Go", "return solution() == 42", """
                        // Sandbox : bibliothèque standard Go (aucun réseau).
                        package main

                        import "fmt"

                        func solution() int {
                        \treturn 42
                        }

                        func main() { fmt.Println(solution()) }
                        """),
                new CaseSpec("Rust", "solution() == 42", """
                        // Sandbox : bibliothèque standard Rust (aucun réseau, pas de crate externe).
                        fn solution() -> i32 {
                            42
                        }

                        fn main() { println!("{}", solution()); }
                        """),
                new CaseSpec("C", "return solution() == 42;", """
                        // Sandbox : bibliothèque standard C (libc, aucun réseau).
                        #include <stdio.h>

                        int solution(void) {
                            return 42;
                        }

                        int main(void) {
                            printf("%d\\n", solution());
                            return 0;
                        }
                        """),
                new CaseSpec("C++", "return solution() == 42;", """
                        // Sandbox : bibliothèque standard C++ (STL, aucun réseau).
                        #include <iostream>

                        int solution() {
                            return 42;
                        }

                        int main() {
                            std::cout << solution() << std::endl;
                            return 0;
                        }
                        """));
        for (CaseSpec c : caseInput) {
            TestResult good = note(c.lang(), c.harnessCode(), c.code());
            assertThat(good.passed())
                    .as("valeurs par défaut en " + c.lang() + " : "
                            + (good.detail() == null ? "" : good.detail()))
                    .isTrue();
            // Et une mauvaise réponse échoue : le test mesure bien la notation, pas un « tout
            // passe ».
            assertThat(note(c.lang(), c.harnessCode(), c.code().replace("42", "41")).passed())
                    .as("mauvaise réponse en " + c.lang())
                    .isFalse();
        }
    }

    @Test
    void error_paths_fail_cleanly() {
        // Fail-closed : aucune de ces situations ne doit donner « réussi », et le motif doit
        // désigner le bon fautif — le prof pour un harnais qui ne compile pas, pas l'étudiant.
        TestResult falseHarness = note("Java", "return Solution.inexistante(3) == 1;",
                "public class Solution { public static int doubler(int n) { return n * 2; } }");
        assertThat(falseHarness.passed()).isFalse();
        assertThat(falseHarness.detail()).contains("harnais");

        TestResult withoutApi = note("Java", "return true;",
                "public class Solution { private static int cache = 1; }");
        assertThat(withoutApi.passed()).isFalse();
        assertThat(withoutApi.detail()).isNotEmpty();

        TestResult brokenCode = note("Rust", "doubler(5) == 10", "fn doubler(n: i32) -> i32 { n *");
        assertThat(brokenCode.passed()).isFalse();
        assertThat(brokenCode.detail()).contains("compilation");

        TestResult throwingHarness = note("Java",
                "throw new IllegalStateException(\"le prof s'est trompé\");",
                "public class Solution { public static int doubler(int n) { return n * 2; } }");
        assertThat(throwingHarness.passed()).isFalse();
        assertThat(throwingHarness.detail()).contains("harnais");
    }

    @Test
    void honest_chatty_code_passes_in_the_other_five_languages() {
        // « Ne pas accuser un étudiant honnête » a déjà demandé trois correctifs : la propriété
        // doit être mesurée dans CHAQUE langage, pas seulement en Java.
        record CaseSpec(String lang, String harnessCode, String code) { }
        List<CaseSpec> caseInput = List.of(
                new CaseSpec("Go", "return doubler(5) == 10", """
                        package main

                        import "fmt"

                        func doubler(n int) int {
                        \tfmt.Println("je calcule", n)
                        \treturn n * 2
                        }

                        func main() { fmt.Println(doubler(21)) }
                        """),
                new CaseSpec("Rust", "doubler(5) == 10", """
                        fn doubler(n: i32) -> i32 {
                            println!("je calcule {}", n);
                            eprintln!("trace");
                            n * 2
                        }

                        fn main() { println!("{}", doubler(21)); }
                        """),
                new CaseSpec("C", "return doubler(5) == 10;", """
                        #include <stdio.h>

                        int doubler(int n) {
                            printf("je calcule %d\\n", n);
                            fflush(stdout);
                            return n * 2;
                        }

                        int main(void) { printf("%d\\n", doubler(21)); return 0; }
                        """),
                new CaseSpec("C++", "return doubler(5) == 10;", """
                        #include <iostream>

                        int doubler(int n) {
                            std::cout << "je calcule " << n << std::endl;
                            return n * 2;
                        }

                        int main() { std::cout << doubler(21) << std::endl; return 0; }
                        """),
                new CaseSpec("C#", "return Solution.doubler(5) == 10;", """
                        using System;

                        class Solution {
                            public static int doubler(int n) {
                                Console.WriteLine("je calcule " + n);
                                Console.Error.WriteLine("trace");
                                return n * 2;
                            }

                            public static void Main() { Console.WriteLine(doubler(21)); }
                        }
                        """));
        for (CaseSpec c : caseInput) {
            TestResult r = note(c.lang(), c.harnessCode(), c.code());
            assertThat(r.passed())
                    .as("code honnête mais bavard en " + c.lang() + " : "
                            + (r.detail() == null ? "" : r.detail()))
                    .isTrue();
            assertThat(r.detail() == null ? "" : r.detail()).doesNotContain("⚠");
        }
    }
}
