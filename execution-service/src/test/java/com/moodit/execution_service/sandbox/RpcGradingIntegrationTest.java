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
}
