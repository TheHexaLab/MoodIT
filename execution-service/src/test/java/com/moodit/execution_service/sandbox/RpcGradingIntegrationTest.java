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

    // ───────────────────────────── 1. Le harnais booléen note ─────────────────────────────

    @Test
    void java_bonne_puis_mauvaise_reponse() {
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
    void go_bonne_puis_mauvaise_reponse() {
        String h = "return doubler(5) == 10";
        assertThat(note("Go", h, "package main\n\nfunc doubler(n int) int { return n * 2 }\n")
                .passed()).isTrue();
        assertThat(note("Go", h, "package main\n\nfunc doubler(n int) int { return 0 }\n")
                .passed()).isFalse();
    }

    @Test
    void c_bonne_puis_mauvaise_reponse() {
        String h = "return doubler(5) == 10;";
        assertThat(note("C", h, "int doubler(int n) { return n * 2; }\n").passed()).isTrue();
        assertThat(note("C", h, "int doubler(int n) { return 0; }\n").passed()).isFalse();
    }

    @Test
    void cpp_bonne_puis_mauvaise_reponse() {
        String h = "return doubler(5) == 10;";
        assertThat(note("C++", h, "int doubler(int n) { return n * 2; }\n").passed()).isTrue();
        assertThat(note("C++", h, "int doubler(int n) { return 0; }\n").passed()).isFalse();
    }

    @Test
    void rust_bonne_puis_mauvaise_reponse() {
        String h = "doubler(5) == 10";
        assertThat(note("Rust", h, "fn doubler(n: i32) -> i32 { n * 2 }\n").passed()).isTrue();
        assertThat(note("Rust", h, "fn doubler(n: i32) -> i32 { 0 }\n").passed()).isFalse();
    }

    @Test
    void csharp_bonne_puis_mauvaise_reponse() {
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

    // ───────── 1 bis. Les OBJETS : poignées, l'instance vit chez l'étudiant ─────────

    @Test
    void java_objets_par_poignee() {
        // Le harnais écrit l'appel naturellement ; l'objet est construit DANS le processus de
        // l'étudiant et le noteur n'en manipule qu'une poignée. Champs privés compris : c'est du
        // code normal côté étudiant.
        String h = "return new Solution.Rectangle(3, 4).aire() == 12;";
        String poo = """
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
        assertThat(note("Java", h, poo).passed()).isTrue();
        assertThat(note("Java", h, poo.replace("largeur * hauteur", "0")).passed()).isFalse();
    }

    @Test
    void csharp_objets_par_poignee() {
        String h = "return new Solution(3, 4).Aire() == 12;";
        String poo = """
                public class Solution {
                    private readonly int largeur;
                    private readonly int hauteur;
                    public Solution(int l, int h) { largeur = l; hauteur = h; }
                    public int Aire() { return largeur * hauteur; }
                    public static int Doubler(int n) { return n * 2; }
                }
                """;
        assertThat(note("C#", h, poo).passed()).isTrue();
        assertThat(note("C#", h, poo.replace("largeur * hauteur", "0")).passed()).isFalse();
    }

    @Test
    void go_objets_par_poignee() {
        // Go n'a pas de constructeur : l'idiome est une fonction qui renvoie la structure, et
        // c'est elle qu'on proxifie.
        String h = "return NewRectangle(3, 4).Aire() == 12";
        String poo = """
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
        assertThat(note("Go", h, poo).passed()).isTrue();
        assertThat(note("Go", h, poo.replace("r.largeur * r.hauteur", "0")).passed()).isFalse();
    }

    @Test
    void rust_objets_par_poignee() {
        String h = "Rectangle::new(3, 4).aire() == 12";
        String poo = """
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
        assertThat(note("Rust", h, poo).passed()).isTrue();
        assertThat(note("Rust", h, poo.replace("self.largeur * self.hauteur", "0"))
                .passed()).isFalse();
    }

    @Test
    void cpp_objets_par_poignee() {
        String h = "return Rectangle(3, 4).aire() == 12;";
        // Constructeur à LISTE D'INITIALISATION : la forme du code de départ de la démo.
        String poo = """
                class Rectangle {
                    int largeur, hauteur;
                public:
                    Rectangle(int largeur, int hauteur) : largeur(largeur), hauteur(hauteur) {}
                    int aire() { return largeur * hauteur; }
                };
                """;
        assertThat(note("C++", h, poo).passed()).isTrue();
        assertThat(note("C++", h, poo.replace("largeur * hauteur", "0")).passed()).isFalse();
    }

    // ── Formes RÉELLES des questions POO de la démo (db/demo/V2_3) : ce sont elles qui
    //    décident si la fonctionnalité est utilisable, pas des exemples écrits pour le test.

    @Test
    void go_litteral_a_champs_nommes() {
        // Idiome Go d'une structure sans constructeur, et forme du harnais de la démo.
        String h = "r := Rectangle{largeur: 3, hauteur: 4}\nreturn r.aire() == 12";
        String poo = """
                package main

                type Rectangle struct {
                \tlargeur int
                \thauteur int
                }

                func (r Rectangle) aire() int { return r.largeur * r.hauteur }
                """;
        assertThat(note("Go", h, poo).passed()).isTrue();
        assertThat(note("Go", h, poo.replace("r.largeur * r.hauteur", "0")).passed()).isFalse();
    }

    @Test
    void rust_litteral_a_champs_nommes() {
        String h = "let r = Rectangle { largeur: 3, hauteur: 4 };\nr.aire() == 12";
        String poo = """
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
        assertThat(note("Rust", h, poo).passed()).isTrue();
        assertThat(note("Rust", h, poo.replace("self.largeur * self.hauteur", "0"))
                .passed()).isFalse();
    }

    @Test
    void java_classe_publique_est_l_objet() {
        // La classe publique s'appelle Rectangle : c'est elle qu'on instancie, et il n'y a
        // AUCUNE méthode statique. Exiger une statique refusait cette question.
        String h = "return new Rectangle(3, 4).aire() == 12;";
        String poo = """
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
        assertThat(note("Java", h, poo).passed()).isTrue();
        assertThat(note("Java", h, poo.replace("return largeur * hauteur;", "return 0;"))
                .passed()).isFalse();
    }

    @Test
    void csharp_sans_methode_statique() {
        String h = "return new Rectangle(3, 4).aire() == 12;";
        String poo = """
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
        assertThat(note("C#", h, poo).passed()).isTrue();
        assertThat(note("C#", h, poo.replace("return largeur * hauteur;", "return 0;"))
                .passed()).isFalse();
    }

    // ── Types de retour et idiomes que la première version ne savait pas générer. Chacun de ces
    //    cas rendait « Échec de compilation » à un étudiant dont le code était juste.

    @Test
    void java_tous_les_types_de_retour_marshalables() {
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
    void java_chaine_contenant_un_separateur_du_protocole() {
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
    void rust_methode_avec_parametres() {
        // Les arguments n'étaient ni lus ni transmis côté étudiant : rustc refusait son programme.
        String h = "let c = Compteur { valeur: 10 };\nc.plus(5) == 15";
        String poo = """
                struct Compteur {
                    valeur: i32,
                }

                impl Compteur {
                    fn plus(&self, n: i32) -> i32 {
                        self.valeur + n
                    }
                }
                """;
        assertThat(note("Rust", h, poo).passed()).isTrue();
        assertThat(note("Rust", h, poo.replace("self.valeur + n", "0")).passed()).isFalse();
    }

    @Test
    void go_methode_a_recepteur_pointeur() {
        // L'idiome le plus répandu. L'aiguillage appelait la méthode sur le résultat d'une
        // assertion de type, qui n'est pas adressable : le programme ne compilait pas.
        String h = "c := NewCompteur(10)\nreturn c.Plus(5) == 15";
        String poo = """
                package main

                type Compteur struct {
                \tvaleur int
                }

                func NewCompteur(v int) *Compteur {
                \treturn &Compteur{valeur: v}
                }

                func (c *Compteur) Plus(n int) int { return c.valeur + n }
                """;
        assertThat(note("Go", h, poo).passed()).isTrue();
        assertThat(note("Go", h, poo.replace("c.valeur + n", "0")).passed()).isFalse();
    }

    @Test
    void chaines_et_flottants_sur_les_protocoles_texte() {
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

    // ──────────────────── 2. Forger le résultat : plus aucun canal ────────────────────

    @Test
    void java_forge_de_la_reponse_et_du_jeton_echoue() {
        // Tout à la fois : devancer la réponse RPC, forger un rapport, sortir en zéro, chercher
        // le jeton dans ses fichiers ET dans sa propre mémoire (/proc/self/mem).
        TestResult r = note("Java", "return Solution.doubler(5) == 10;", """
                import java.io.RandomAccessFile;
                import java.nio.file.Files;
                import java.nio.file.Paths;
                import java.util.regex.Matcher;
                import java.util.regex.Pattern;

                public class Solution {
                    static {
                        System.out.println("{\\"ok\\":true,\\"value\\":10}");
                    }

                    public static int doubler(int n) {
                        System.out.println("{\\"ok\\":true,\\"value\\":10}");
                        Pattern p = Pattern.compile("[0-9]{13}");
                        try (RandomAccessFile mem = new RandomAccessFile("/proc/self/mem", "r")) {
                            for (String l : Files.readAllLines(Paths.get("/proc/self/maps"))) {
                                if (!l.contains(" rw")) { continue; }
                                String[] b = l.split(" ")[0].split("-");
                                long debut = Long.parseUnsignedLong(b[0], 16);
                                long fin = Long.parseUnsignedLong(b[1], 16);
                                if (fin - debut > 1_000_000L) { continue; }
                                try {
                                    mem.seek(debut);
                                    byte[] t = new byte[(int) (fin - debut)];
                                    mem.readFully(t);
                                    Matcher m = p.matcher(new String(t,
                                            java.nio.charset.StandardCharsets.ISO_8859_1));
                                    while (m.find()) { System.err.println(m.group()); }
                                } catch (Exception ignore) { }
                            }
                        } catch (Exception ignore) { }
                        return 0;
                    }
                }
                """);
        assertThat(r.passed()).isFalse();
        // Le refus doit venir du HARNAIS, pas d'un code d'attaque qui ne compile plus :
        // sans cette assertion, le test resterait vert en ayant cessé de mesurer la forge.
        assertThat(r.detail() == null ? "" : r.detail())
                .doesNotContain("Échec de compilation");
    }

    @Test
    void c_interposition_de_printf_echoue() {
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
        assertThat(r.detail() == null ? "" : r.detail())
                .doesNotContain("Échec de compilation");
    }

    @Test
    void go_devancer_la_reponse_echoue() {
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
        assertThat(r.detail() == null ? "" : r.detail())
                .doesNotContain("Échec de compilation");
    }

    @Test
    void csharp_dup2_et_reflexion_echouent() {
        // mono autorise l'appel natif : on tente de detourner le descripteur 1 et de fouiller
        // l'assemblage par reflexion. Le noteur est ailleurs, sous un autre UID.
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
        // Le refus doit venir du HARNAIS, pas d'un code d'attaque qui ne compile plus :
        // sans cette assertion, le test resterait vert en ayant cessé de mesurer la forge.
        assertThat(r.detail() == null ? "" : r.detail())
                .doesNotContain("Échec de compilation");
    }

    // ────────────── 3. Le harnais du prof : ni lisible, ni modifiable ──────────────

    @Test
    void java_harnais_introuvable_et_immodifiable() {
        TestResult r = note("Java", "return Solution.doubler(5) == 10;", """
                import java.nio.file.Files;
                import java.nio.file.Path;
                import java.nio.file.Paths;
                import java.util.stream.Stream;

                public class Solution {
                    public static int doubler(int n) {
                        boolean vu = false;
                        try (Stream<Path> f = Files.walk(Paths.get("/box"))) {
                            for (Path p : f.filter(Files::isRegularFile).toList()) {
                                try {
                                    String t = new String(Files.readAllBytes(p),
                                            java.nio.charset.StandardCharsets.ISO_8859_1);
                                    if (t.contains("doubler(5) == 10")) {
                                        vu = true;
                                        Files.write(p, "return true;".getBytes());
                                    }
                                } catch (Exception ignore) { }
                            }
                        } catch (Exception ignore) { }
                        return vu ? 10 : 0;
                    }
                }
                """);
        assertThat(r.passed())
                .as("le harnais ne doit être ni lisible ni modifiable depuis le code noté")
                .isFalse();
    }

    @Test
    void c_harnais_introuvable() {
        TestResult r = note("C", "return doubler(5) == 10;", """
                #include <stdio.h>
                #include <string.h>

                int doubler(int n) {
                    /* Balayage du dossier du cas a la recherche du texte du harnais. */
                    FILE *p = popen("grep -rl 'doubler(5)' /box 2>/dev/null | head -1", "r");
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
    }

    // ───────────────────────── 4. Pas de fausse accusation ─────────────────────────

    @Test
    void code_honnete_bavard_passe_quand_meme() {
        // Un étudiant qui imprime, ferme ses flux, ou appelle sa propre fonction depuis son main
        // ne doit pas être pénalisé : sa sortie n'est plus un canal de verdict.
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
    void idiomes_et_valeurs_que_la_revue_a_trouves_non_couverts() {
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
    void rust_fonction_associee_ou_imbriquee_ne_casse_pas_la_compilation() {
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
    void rust_methode_mutante_nest_pas_notee_a_tort() {
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
    void java_exception_du_code_soumis_donne_son_motif_et_pas_un_timeout() {
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
    void sortie_non_terminee_par_un_saut_de_ligne_ne_bloque_pas_le_couple() {
        // Le stdout du code noté EST le canal de réponse et il partage son tampon : une dernière
        // écriture sans saut de ligne se collait au début de la ligne de réponse, qui n'était
        // alors plus reconnue. Le couple s'attendait, et une réponse JUSTE était notée
        // « Interrompu (temps limite dépassé) » après avoir brûlé tout son temps.
        record Cas(String langage, String harnais, String code) { }
        List<Cas> cas = List.of(
                new Cas("Java", "return Solution.doubler(5) == 10;", """
                        public class Solution {
                            public static int doubler(int n) {
                                System.out.print("sans saut de ligne");
                                return n * 2;
                            }
                        }
                        """),
                new Cas("Rust", "doubler(5) == 10", """
                        fn doubler(n: i32) -> i32 {
                            print!("sans saut de ligne");
                            n * 2
                        }
                        """),
                new Cas("Go", "return doubler(5) == 10", """
                        package main

                        import "fmt"

                        func doubler(n int) int {
                        \tfmt.Print("sans saut de ligne")
                        \treturn n * 2
                        }
                        """),
                new Cas("C", "return doubler(5) == 10;", """
                        #include <stdio.h>

                        int doubler(int n) {
                            printf("sans saut de ligne");
                            return n * 2;
                        }
                        """),
                new Cas("C++", "return doubler(5) == 10;", """
                        #include <iostream>

                        int doubler(int n) {
                            std::cout << "sans saut de ligne";
                            return n * 2;
                        }
                        """),
                new Cas("C#", "return Solution.doubler(5) == 10;", """
                        using System;

                        class Solution {
                            public static int doubler(int n) {
                                Console.Write("sans saut de ligne");
                                return n * 2;
                            }
                        }
                        """));
        for (Cas c : cas) {
            TestResult r = note(c.langage(), c.harnais(), c.code());
            assertThat(r.passed())
                    .as("sortie non terminée en " + c.langage() + " : "
                            + (r.detail() == null ? "" : r.detail()))
                    .isTrue();
        }
    }

    @Test
    void chemins_d_erreur_echouent_proprement() {
        // Fail-closed : aucune de ces situations ne doit donner « réussi », et le motif doit
        // désigner le bon fautif — le prof pour un harnais qui ne compile pas, pas l'étudiant.
        TestResult harnaisFaux = note("Java", "return Solution.inexistante(3) == 1;",
                "public class Solution { public static int doubler(int n) { return n * 2; } }");
        assertThat(harnaisFaux.passed()).isFalse();
        assertThat(harnaisFaux.detail()).contains("harnais");

        TestResult sansApi = note("Java", "return true;",
                "public class Solution { private static int cache = 1; }");
        assertThat(sansApi.passed()).isFalse();
        assertThat(sansApi.detail()).isNotEmpty();

        TestResult codeCasse = note("Rust", "doubler(5) == 10", "fn doubler(n: i32) -> i32 { n *");
        assertThat(codeCasse.passed()).isFalse();
        assertThat(codeCasse.detail()).contains("compilation");

        TestResult harnaisQuiLeve = note("Java",
                "throw new IllegalStateException(\"le prof s'est trompé\");",
                "public class Solution { public static int doubler(int n) { return n * 2; } }");
        assertThat(harnaisQuiLeve.passed()).isFalse();
        assertThat(harnaisQuiLeve.detail()).contains("harnais");
    }

    @Test
    void code_honnete_bavard_passe_dans_les_cinq_autres_langages() {
        // « Ne pas accuser un étudiant honnête » a déjà demandé trois correctifs : la propriété
        // doit être mesurée dans CHAQUE langage, pas seulement en Java.
        record Cas(String langage, String harnais, String code) { }
        List<Cas> cas = List.of(
                new Cas("Go", "return doubler(5) == 10", """
                        package main

                        import "fmt"

                        func doubler(n int) int {
                        \tfmt.Println("je calcule", n)
                        \treturn n * 2
                        }

                        func main() { fmt.Println(doubler(21)) }
                        """),
                new Cas("Rust", "doubler(5) == 10", """
                        fn doubler(n: i32) -> i32 {
                            println!("je calcule {}", n);
                            eprintln!("trace");
                            n * 2
                        }

                        fn main() { println!("{}", doubler(21)); }
                        """),
                new Cas("C", "return doubler(5) == 10;", """
                        #include <stdio.h>

                        int doubler(int n) {
                            printf("je calcule %d\\n", n);
                            fflush(stdout);
                            return n * 2;
                        }

                        int main(void) { printf("%d\\n", doubler(21)); return 0; }
                        """),
                new Cas("C++", "return doubler(5) == 10;", """
                        #include <iostream>

                        int doubler(int n) {
                            std::cout << "je calcule " << n << std::endl;
                            return n * 2;
                        }

                        int main() { std::cout << doubler(21) << std::endl; return 0; }
                        """),
                new Cas("C#", "return Solution.doubler(5) == 10;", """
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
        for (Cas c : cas) {
            TestResult r = note(c.langage(), c.harnais(), c.code());
            assertThat(r.passed())
                    .as("code honnête mais bavard en " + c.langage() + " : "
                            + (r.detail() == null ? "" : r.detail()))
                    .isTrue();
            assertThat(r.detail() == null ? "" : r.detail()).doesNotContain("⚠");
        }
    }
}
