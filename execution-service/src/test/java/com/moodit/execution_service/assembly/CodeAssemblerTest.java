package com.moodit.execution_service.assembly;

import com.moodit.execution_service.piston.PistonClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Tests unitaires de l'assemblage par langage (aucun Piston requis) : on vérifie la STRUCTURE du
 * programme assemblé — langage Piston, fichiers, présence du code étudiant, du harnais, et surtout
 * du NONCE anti-triche, ainsi que les astuces par langage (renommage de main, macros, alias).
 */
class CodeAssemblerTest {

    // Dossier vendor bidon : les langages testés ici (python/js/json/sql/c/java…) ne le lisent pas
    // (seuls HTML/JSX chargent un bundle, non couverts par ces tests unitaires).
    private final CodeAssembler assembler = new CodeAssembler("/nonexistent-vendor");

    private String onlyFileContent(CodeAssembler.Assembled a) {
        assertThat(a.files()).hasSize(1);
        return a.files().get(0).content();
    }

    @Test
    void python_isolates_student_in_a_separate_process_via_rpc() {
        var a = assembler.assemble("Python", "def solution():\n    return 5",
                "return solution() == 5", "MOODIT_OK_deadbeef");
        assertThat(a.pistonLanguage()).isEqualTo("python");
        // Deux fichiers : le NOTEUR (grader.py, en 1er = point d'entrée) et le SERVEUR étudiant.
        assertThat(a.files()).extracting(PistonClient.File::name)
                .containsExactly("grader.py", "student_server.py");
        String grader = a.files().get(0).content();
        String server = a.files().get(1).content();
        // Le harnais + le nonce sont dans le NOTEUR ; le code étudiant dans le SERVEUR (isolé).
        assertThat(grader)
                .contains("return solution() == 5")     // harnais du prof, inchangé
                .contains("__moodit_harness")
                .contains("MOODIT_OK_deadbeef")         // nonce émis par le noteur (sûr)
                .contains("def solution(*a):")          // proxy RPC injecté pour « solution »
                .contains("os.remove('grader.py')");    // auto-suppression (hors de portée du serveur)
        assertThat(server)
                .contains("def solution()")             // vrai code étudiant, côté serveur
                .doesNotContain("MOODIT_OK_deadbeef");  // AUCUN nonce côté étudiant → plus de résiduel
    }

    /**
     * Invariant de sécurité du modèle RPC (langages interprétés) : le NOTEUR (1er fichier) porte le
     * harnais + le nonce ; le SERVEUR (2e fichier) porte le code étudiant SANS le nonce. C'est ce qui
     * ferme le résiduel (le code étudiant, isolé, n'a aucun secret à extraire).
     */
    private void assertRpcIsolation(CodeAssembler.Assembled a, String harnessMarker,
            String studentMarker, String nonce) {
        assertThat(a.files().size()).isGreaterThanOrEqualTo(2);
        String grader = a.files().get(0).content();
        String server = a.files().get(1).content();
        assertThat(grader).contains(harnessMarker).contains(nonce);       // harnais inchangé + nonce, côté noteur
        assertThat(server).contains(studentMarker).doesNotContain(nonce); // code étudiant, AUCUN nonce
    }

    @Test
    void javascript_isolates_student_via_rpc() {
        var a = assembler.assemble("JavaScript", "function doubler(n){ return n*2; }",
                "return doubler(5) === 10;", "MOODIT_OK_js");
        assertThat(a.pistonLanguage()).isEqualTo("javascript");
        assertThat(a.files()).extracting(PistonClient.File::name)
                .containsExactly("grader.js", "student_server.js");
        assertRpcIsolation(a, "return doubler(5) === 10;", "function doubler(n)", "MOODIT_OK_js");
        assertThat(a.files().get(0).content())
                .contains("function doubler(...a)")     // proxy RPC de la fonction
                .contains("unlinkSync('grader.js')");   // auto-suppression du noteur
    }

    @Test
    void typescript_uses_extensionless_names_and_ts_nocheck() {
        var a = assembler.assemble("TypeScript", "function doubler(n: number): number { return n*2; }",
                "return doubler(5) === 10;", "MOODIT_OK_ts");
        assertThat(a.pistonLanguage()).isEqualTo("typescript");
        // Fichiers SANS extension → Piston écrit du .ts et compile en .js (student_server.js).
        assertThat(a.files()).extracting(PistonClient.File::name)
                .containsExactly("grader", "student_server");
        assertThat(a.files().get(0).content()).startsWith("// @ts-nocheck");
        assertRpcIsolation(a, "return doubler(5) === 10;", "function doubler(n: number)", "MOODIT_OK_ts");
    }

    @Test
    void php_isolates_student_via_rpc() {
        var a = assembler.assemble("PHP", "<?php\nfunction doubler($n){ return $n*2; }",
                "return doubler(5) === 10;", "MOODIT_OK_php");
        assertThat(a.pistonLanguage()).isEqualTo("php");
        assertThat(a.files()).extracting(PistonClient.File::name)
                .containsExactly("grader.php", "student_server.php");
        assertRpcIsolation(a, "return doubler(5) === 10;", "function doubler($n)", "MOODIT_OK_php");
        assertThat(a.files().get(0).content())
                .contains("function doubler(...$a)").contains("@unlink('grader.php')");
    }

    @Test
    void bash_isolates_student_via_rpc() {
        var a = assembler.assemble("Bash", "doubler() { echo $(( $1 * 2 )); }",
                "[ \"$(doubler 5)\" = \"10\" ]", "MOODIT_OK_bash");
        assertThat(a.pistonLanguage()).isEqualTo("bash");
        assertThat(a.files()).extracting(PistonClient.File::name)
                .containsExactly("grader.sh", "student_server.sh");
        assertRpcIsolation(a, "$(doubler 5)", "doubler() {", "MOODIT_OK_bash");
        assertThat(a.files().get(0).content())
                .contains("doubler() { __moodit_rpc doubler").contains("rm -f grader.sh");
    }

    @Test
    void python_class_proxy_avoids_name_mangling() {
        var a = assembler.assemble("Python", "class Rectangle:\n    def aire(self):\n        return 12",
                "return Rectangle(3, 4).aire() == 12", "MOODIT_OK_r");
        // Dans un corps de classe, `__moodit_rpc` serait manglé (→ _Rectangle__moodit_rpc). On passe
        // donc par globals()[...] (clé string, non manglée).
        assertThat(a.files().get(0).content())
                .contains("class Rectangle:")
                .contains("globals()[\"__moodit_rpc\"]");
    }

    @Test
    void student_name_colliding_with_internals_is_not_proxied() {
        // Un étudiant qui nomme un symbole « __moodit… » n'est PAS proxifié → pas de collision avec
        // l'infrastructure du noteur (fs, _rpc…).
        var a = assembler.assemble("JavaScript", "function __moodit_x(){}\nfunction doubler(n){ return n*2; }",
                "return doubler(5) === 10;", "MOODIT_OK_x");
        assertThat(a.files().get(0).content())
                .contains("function doubler(...a)")
                .doesNotContain("function __moodit_x(...a)");
    }

    @Test
    void jsx_isolates_render_and_keeps_nonce_out_of_student_reach(@TempDir Path vendorDir) throws Exception {
        Files.writeString(vendorDir.resolve("react-runtime.js"), "module.exports = {};");
        var asm = new CodeAssembler(vendorDir.toString());
        var a = asm.assemble("JSX", "function Composant(){ return React.createElement('h1', null, 'Bonjour'); }",
                "return html.includes('<h1>Bonjour</h1>');", "MOODIT_OK_jsx");
        assertThat(a.files()).extracting(PistonClient.File::name)
                .containsExactly("main.js", "jsx-server.js", "react-runtime.js", "component.tsx")
                .doesNotContain("moodit-nonce.txt", "harness.js");   // plus de fichier nonce ni harnais voisin
        String grader = a.files().get(0).content();
        assertThat(grader)
                .contains("html.includes('<h1>Bonjour</h1>')")       // harnais du prof, inchangé
                .contains("MOODIT_OK_jsx")                           // nonce dans le noteur
                .contains("unlinkSync('main.js')")                  // auto-suppression du noteur
                .contains("op:'mount'").contains("op:'click'");     // proxy DOM (interactif)
        String server = a.files().stream().filter(f -> f.name().equals("jsx-server.js"))
                .findFirst().orElseThrow().content();
        String component = a.files().stream().filter(f -> f.name().equals("component.tsx"))
                .findFirst().orElseThrow().content();
        assertThat(server).doesNotContain("MOODIT_OK_jsx");         // serveur de rendu : aucun nonce
        assertThat(component).contains("Composant").doesNotContain("MOODIT_OK_jsx");
    }

    @Test
    void java_puts_our_entry_first_and_reads_secret_from_stdin() {
        var a = assembler.assemble("Java",
                "public class Solution { public static int solution(){ return 5; } "
                        + "public static void main(String[] a){} }",
                "return Solution.solution() == 5;", "MOODIT_OK_java");
        assertThat(a.pistonLanguage()).isEqualTo("java");
        String c = onlyFileContent(a);
        assertThat(c).contains("public class __MooditMain");    // notre classe d'entrée (JEP 330)
        assertThat(c.indexOf("__MooditMain")).isLessThan(c.indexOf("__MooditStudent_Solution"));
        assertThat(c).contains("__MooditStudent_Solution");     // classe étudiant renommée (le réel)
        assertThat(c).contains("class Solution {");             // stub de même nom pour le harnais
        // ANTI-TRICHE : le nonce n'est PAS gravé — lu depuis stdin par le parent (noteur).
        assertThat(c).doesNotContain("MOODIT_OK_java");
        assertThat(c).contains("System.in").contains("ProcessBuilder");   // 2e JVM (serveur étudiant)
        // Le secret est lu AVANT l'appel au harnais.
        int readIdx    = c.indexOf("readLine");
        int harnessIdx = c.indexOf("__moodit_harness();");
        assertThat(readIdx).isPositive();
        assertThat(harnessIdx).isGreaterThan(readIdx);
    }

    @Test
    void java_poo_genere_constructeur_et_methode_dinstance_par_handle() {
        // Classe POO : ctor + méthode d'instance → le stub doit déléguer par handle (@new/@call),
        // le child doit instancier/appeler par réflexion (le harnais fait new Rectangle(3,4).aire()).
        var a = assembler.assemble("Java",
                "public class Rectangle { int l, h; public Rectangle(int l, int h){ this.l=l; this.h=h; } "
                        + "public int aire(){ return l*h; } }",
                "return new Rectangle(3,4).aire() == 12;", "MOODIT_OK_poo");
        String c = onlyFileContent(a);
        assertThat(c).contains("class Rectangle {").contains("int __moodit_h");   // stub + handle
        assertThat(c).contains("__MooditMain.__rpcNew(\"Rectangle\"");            // ctor → @new
        assertThat(c).contains("__MooditMain.__rpcCall(__moodit_h, \"aire\"");    // méthode → @call
        assertThat(c).contains("case \"@new\"").contains("case \"@call\"");       // dispatch child
        assertThat(c).contains("getDeclaredConstructors").contains("getDeclaredMethods"); // réflexion
        assertThat(c).contains("__MooditStudent_Rectangle");                      // vrai code renommé
        assertThat(c).doesNotContain("MOODIT_OK_poo");                            // nonce jamais gravé
    }

    @Test
    void java_poo_genere_un_programme_qui_compile(@TempDir Path dir) throws Exception {
        // Garde-fou : le programme POO assemblé doit COMPILER (stubs ctor/méthode, dispatch @new/@call,
        // helpers de réflexion). Classe étudiant package-private pour que javac strict accepte le nom de
        // fichier (en vrai, Piston lance `java Main.java` en mode fichier-source, qui ignore cette règle).
        var a = assembler.assemble("Java",
                "class Rectangle { int l, h; Rectangle(int l, int h){ this.l=l; this.h=h; } "
                        + "int aire(){ return l*h; } static void main(String[] x){} }",
                "return new Rectangle(3,4).aire() == 12;", "MOODIT_OK_poo");
        Path javac = Path.of(System.getProperty("java.home"), "bin", "javac");
        if (!Files.exists(javac)) return; // pas de JDK (JRE seul) → on saute ce garde-fou
        Path src = dir.resolve("__MooditMain.java");
        Files.writeString(src, onlyFileContent(a));
        Process p = new ProcessBuilder(javac.toString(), src.toString())
                .redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes());
        int code = p.waitFor();
        assertThat(code).withFailMessage("javac a échoué :\n%s", out).isZero();
    }

    @Test
    void csharp_poo_genere_constructeur_et_methode_dinstance_par_handle() {
        // POO C# : ctor + méthode d'instance → le stub délègue par handle (@new/@call), le child
        // instancie/appelle par réflexion (le harnais fait new Rectangle(3,4).Aire()).
        var a = assembler.assemble("C#",
                "class Rectangle { int l, h; public Rectangle(int l, int h){ this.l=l; this.h=h; } "
                        + "public int Aire(){ return l*h; } static void Main(string[] x){} }",
                "return new Rectangle(3,4).Aire() == 12;", "MOODIT_OK_poo");
        String c = onlyFileContent(a);
        assertThat(c).contains("class Rectangle {").contains("int __moodit_h");
        assertThat(c).contains("__MooditMain.__rpcNew(\"Rectangle\"");
        assertThat(c).contains("__MooditMain.__rpcCall(__moodit_h, \"Aire\"");
        assertThat(c).contains("case \"@new\"").contains("case \"@call\"");
        assertThat(c).contains("GetConstructors").contains("GetMethods");           // réflexion
        assertThat(c).contains("__MooditStudent_Rectangle");
        assertThat(c).doesNotContain("MOODIT_OK_poo");
    }

    @Test
    void java_poo_couvre_void_prive_et_types_non_supportes() {
        // Exerce les branches POO : méthode d'instance void, membre privé (ignoré), retour/param non
        // scalaire (stub qui lève), ctor à paramètre non scalaire (ignoré).
        var a = assembler.assemble("Java",
                "class Widget { int x;\n"
                        + "  Widget(int x){ this.x=x; }\n"
                        + "  Widget(int[] xs){ this.x=xs.length; }\n"   // ctor non scalaire → ignoré
                        + "  public void reset(){ x=0; }\n"              // void d'instance
                        + "  private int secret(){ return x; }\n"       // privé → non exposé
                        + "  public int[] dump(){ return new int[]{x}; }\n" // retour non scalaire → lève
                        + "  public int get(){ return x; } }",
                "return new Widget(1).get() == 1;", "N");
        String c = onlyFileContent(a);
        assertThat(c).contains("void reset(");                                  // branche void
        assertThat(c).contains("int[] dump() { throw new RuntimeException");    // non supporté → lève
        assertThat(c).doesNotContain("\"secret\"");                            // privé non proxifié
        assertThat(c).containsOnlyOnce("__rpcNew(\"Widget\"");                  // seul le ctor scalaire
    }

    @Test
    void go_poo_genere_stub_struct_et_methode_par_passage_de_champs() {
        // POO Go : struct + méthode → stub type (mêmes champs) + méthode qui envoie les champs ; le
        // child reconstruit le vrai struct et appelle la méthode (le harnais fait Rectangle{...}.aire()).
        var a = assembler.assemble("Go",
                "package main\n"
                        + "type Rectangle struct { largeur, hauteur int }\n"
                        + "func (r Rectangle) aire() int { return r.largeur * r.hauteur }\n"
                        + "func main() {}",
                "return Rectangle{largeur: 3, hauteur: 4}.aire() == 12", "MOODIT_OK_go");
        String c = onlyFileContent(a);
        assertThat(c).contains("type Rectangle struct { largeur int; hauteur int }");  // stub (mêmes champs)
        assertThat(c).contains("func (__self Rectangle) aire() int");                  // méthode stub
        assertThat(c).contains("__moodit_rpc(\"Rectangle.aire\", __self.largeur, __self.hauteur)");
        assertThat(c).contains("case \"Rectangle.aire\":");                            // dispatch child
        assertThat(c).contains("__MooditStudent_Rectangle{");                          // reconstruction
        assertThat(c).doesNotContain("MOODIT_OK_go");                                  // nonce jamais gravé
    }

    @Test
    void go_poo_ignore_struct_non_scalaire_et_methode_non_supportee() {
        // Exerce : struct à champ non scalaire → ignoré (pas de stub) ; méthode à retour non scalaire
        // sur un struct scalaire → stub qui panique.
        var a = assembler.assemble("Go",
                "package main\n"
                        + "type Bag struct { items []map[string]int }\n"          // champ non scalaire → struct ignoré
                        + "type Box struct { n int }\n"
                        + "func (b Box) items() []map[string]int { return nil }\n" // retour non scalaire → panique
                        + "func (b Box) get() int { return b.n }\n"
                        + "func main() {}",
                "return Box{n: 7}.get() == 7", "N");
        String c = onlyFileContent(a);
        assertThat(c).doesNotContain("type Bag struct");                          // struct non scalaire ignoré
        assertThat(c).contains("type Box struct { n int }");
        assertThat(c).contains("func (__self Box) items() []map[string]int { panic(");  // méthode non supportée
        assertThat(c).contains("case \"Box.get\":");
    }

    @Test
    void csharp_poo_couvre_void_prive_et_types_non_supportes() {
        var a = assembler.assemble("C#",
                "class Widget { int x;\n"
                        + "  public Widget(int x){ this.x=x; }\n"
                        + "  public Widget(int[] xs){ this.x=xs.Length; }\n"  // ctor non scalaire → ignoré
                        + "  public void Reset(){ x=0; }\n"                    // void d'instance
                        + "  private int Secret(){ return x; }\n"             // privé → non exposé
                        + "  public int[] Dump(){ return new int[]{x}; }\n"   // retour non scalaire → lève
                        + "  public int Get(){ return x; }\n"
                        + "  static void Main(string[] a){} }",
                "return new Widget(1).Get() == 1;", "N");
        String c = onlyFileContent(a);
        assertThat(c).contains("void Reset(");
        assertThat(c).contains("int[] Dump() { throw new System.Exception");
        assertThat(c).doesNotContain("\"Secret\"");
        assertThat(c).containsOnlyOnce("__rpcNew(\"Widget\"");
    }

    @Test
    void c_forks_isolated_process_and_reads_secret_from_stdin() {
        var a = assembler.assemble("C", "int solution(void){ return 5; }",
                "return solution() == 5;", "MOODIT_OK_c");
        String c = onlyFileContent(a);
        // Renommage étudiant par macro + second processus par fork().
        assertThat(c).contains("#define solution __moodit_s_solution");
        assertThat(c).contains("#define main __moodit_student_main").contains("#undef main");
        assertThat(c).contains("fork(");
        assertThat(c).contains("int solution(void) {");         // stub de même nom pour le harnais
        // ANTI-TRICHE : le nonce n'est PAS gravé — lu sur stdin par le parent (noteur).
        assertThat(c).doesNotContain("MOODIT_OK_c");
    }

    @Test
    void language_aliases_are_resolved() {
        assertThat(assembler.assemble("js", "function solution(){}", "return true;", "N").pistonLanguage())
                .isEqualTo("javascript");
        assertThat(assembler.assemble("cpp", "int solution(){return 0;}", "return true;", "N").pistonLanguage())
                .isEqualTo("c++");
        assertThat(assembler.assemble("c#", "class S{}", "return true;", "N").pistonLanguage())
                .isEqualTo("csharp");
    }

    @Test
    void json_produces_main_and_submission_files() {
        var a = assembler.assemble("JSON", "{\"nom\":\"Alice\"}", "return data.nom === 'Alice';", "N");
        assertThat(a.pistonLanguage()).isEqualTo("javascript");
        assertThat(a.files()).extracting(PistonClient.File::name)
                .containsExactlyInAnyOrder("main.js", "submission.json");
    }

    @Test
    void sql_exposes_student_query_as_solution_view() {
        var a = assembler.assemble("SQL", "SELECT nom FROM t", "SELECT count(*) FROM solution = 1;", "N");
        assertThat(a.pistonLanguage()).isEqualTo("sqlite3");
        // Requête unique → solution1, et l'alias « solution » pour la compat mono-requête.
        assertThat(onlyFileContent(a))
                .contains("CREATE VIEW solution1 AS")
                .contains("CREATE VIEW solution AS SELECT * FROM solution1;");
    }

    @Test
    void sql_exposes_each_student_query_as_numbered_view() {
        var a = assembler.assemble("SQL", "SELECT 1;\nSELECT 2", "SELECT 1;", "N");
        String content = onlyFileContent(a);
        assertThat(content)
                .contains("CREATE VIEW solution1 AS")
                .contains("CREATE VIEW solution2 AS");
    }

    @Test
    void sql_wraps_every_statement_so_a_semicolon_cannot_inject() {
        // Tentative d'injection : la 2e instruction ne doit JAMAIS être libre — elle est enfermée
        // dans un CREATE VIEW (où « DROP TABLE » est une erreur de syntaxe, jamais exécutée).
        var a = assembler.assemble("SQL", "SELECT 1;\nDROP TABLE utilisateurs", "SELECT 1;", "N");
        String content = onlyFileContent(a);
        assertThat(content).contains("CREATE VIEW solution2 AS\nDROP TABLE utilisateurs");
        // Aucune instruction DROP au premier niveau (toujours précédée d'un « AS »).
        assertThat(content).doesNotContain(";\nDROP TABLE");
    }

    @Test
    void sql_semicolon_inside_a_string_literal_is_not_a_separator() {
        var a = assembler.assemble("SQL", "SELECT ';' AS x", "SELECT 1;", "N");
        String content = onlyFileContent(a);
        assertThat(content).contains("CREATE VIEW solution1 AS");
        assertThat(content).doesNotContain("CREATE VIEW solution2 AS"); // une seule instruction
    }

    @Test
    void splitSqlStatements_ignores_comments_and_blank_segments() {
        // Un commentaire de fin seul après le ; ne compte pas comme une instruction.
        assertThat(CodeAssembler.splitSqlStatements("SELECT 1; -- fini\n")).containsExactly("SELECT 1");
        assertThat(CodeAssembler.splitSqlStatements("  ;;  ")).isEmpty();
    }

    @Test
    void splitSqlStatements_un_tiret_isole_n_ouvre_pas_de_commentaire() {
        // « 5-3 » est une soustraction : seul « -- » ouvre un commentaire de ligne.
        assertThat(CodeAssembler.splitSqlStatements("SELECT 5-3; SELECT 2"))
                .containsExactly("SELECT 5-3", "SELECT 2");
    }

    @Test
    void splitSqlStatements_un_point_virgule_dans_un_commentaire_de_ligne_ne_separe_pas() {
        // Commentaire en début de ligne (après un saut de ligne) et « ; » juste avant le saut de ligne.
        assertThat(CodeAssembler.splitSqlStatements("SELECT 1\n-- a;b\nFROM t"))
                .containsExactly("SELECT 1\n-- a;b\nFROM t");
        assertThat(CodeAssembler.splitSqlStatements("SELECT 1 -- x;\nFROM t"))
                .containsExactly("SELECT 1 -- x;\nFROM t");
    }

    @Test
    void splitSqlStatements_un_point_virgule_dans_un_commentaire_de_bloc_ne_separe_pas() {
        // « */ » qui précède l'ouverture « /* » n'est pas la fermeture du commentaire.
        assertThat(CodeAssembler.splitSqlStatements("SELECT 2*/*c;*/3"))
                .containsExactly("SELECT 2*/*c;*/3");
        assertThat(CodeAssembler.splitSqlStatements("SELECT 1 /* a; b */ FROM t; SELECT 2"))
                .containsExactly("SELECT 1 /* a; b */ FROM t", "SELECT 2");
    }

    @Test
    void splitSqlStatements_un_point_virgule_dans_un_identifiant_crochete_ne_separe_pas() {
        assertThat(CodeAssembler.splitSqlStatements("SELECT [a][x;y] FROM t"))
                .containsExactly("SELECT [a][x;y] FROM t");
        assertThat(CodeAssembler.splitSqlStatements("SELECT [x;] FROM t; SELECT 2"))
                .containsExactly("SELECT [x;] FROM t", "SELECT 2");
    }

    @Test
    void splitSqlStatements_litteral_final_et_delimiteurs_doubles() {
        // Littéral fermé sur le DERNIER caractère, et délimiteur doublé (échappé) contenant un « ; ».
        assertThat(CodeAssembler.splitSqlStatements("SELECT 'x'")).containsExactly("SELECT 'x'");
        assertThat(CodeAssembler.splitSqlStatements("SELECT 'a'';b'; SELECT \"c;d\"; SELECT `e;f`"))
                .containsExactly("SELECT 'a'';b'", "SELECT \"c;d\"", "SELECT `e;f`");
        // Littéral ne contenant qu'un guillemet échappé (« '''' ») : bien refermé avant le « ; ».
        assertThat(CodeAssembler.splitSqlStatements("SELECT ''''; SELECT 2"))
                .containsExactly("SELECT ''''", "SELECT 2");
        // Littéral jamais fermé : on garde tout jusqu'au bout.
        assertThat(CodeAssembler.splitSqlStatements("SELECT 'a;b")).containsExactly("SELECT 'a;b");
    }

    @Test
    void sql_readonly_fences_the_verdict_with_nonce_sentinels() {
        // Lecture seule : la sortie du verdict est encadrée par les sentinelles au nonce.
        String ro = onlyFileContent(assembler.assemble("SQL", "SELECT 1", "SELECT 1;", "N"));
        assertThat(ro).contains("SELECT 'N_VERDICT_START'").contains("SELECT 'N_VERDICT_END'");
    }

    @Test
    void sql_marker_is_detected() {
        assertThat(CodeAssembler.sqlHasStudentMarker("CREATE TABLE t(n);\n-- @student\nSELECT 1;")).isTrue();
        assertThat(CodeAssembler.sqlHasStudentMarker("SELECT count(*) FROM solution1;")).isFalse();
    }

    @Test
    void sql_marker_in_student_code_is_ignored_in_readonly() {
        // SÉCURITÉ : « -- @student » dans le CODE de l'étudiant reste un simple commentaire — le mode
        // (et le découpage) ne dépend QUE du harnais. Ici pas de marqueur au harnais → lecture seule.
        var a = assembler.assemble("SQL", "SELECT nom FROM t -- @student", "SELECT 1;", "N");
        assertThat(onlyFileContent(a)).contains("CREATE VIEW solution1 AS");
    }

    @Test
    void sql_phase1_sandboxes_student_between_setup_and_fenced_dump() {
        String harness = "CREATE TABLE t (n INT);\nINSERT INTO t VALUES (1);\n"
                + "-- @student\n"
                + "SELECT (SELECT count(*) FROM t) = 0;";
        String content = onlyFileContent(assembler.assembleSqlPhase1("DELETE FROM t", harness, "N"));
        // Setup AVANT le code étudiant ; le verdict du prof (après marqueur) n'apparaît PAS en phase 1.
        assertThat(content.indexOf("INSERT INTO t")).isLessThan(content.indexOf("DELETE FROM t"));
        assertThat(content).doesNotContain("SELECT (SELECT count(*)");
        // Le dump est encadré et vient APRÈS le code étudiant.
        assertThat(content).contains(".dump");
        assertThat(content.indexOf("DELETE FROM t")).isLessThan(content.indexOf("SELECT 'N_DUMP_START'"));
    }

    @Test
    void sql_phase1_does_not_restrict_student_code() {
        // Isolation : en phase 1 (bac à sable jetable) le DDL de l'étudiant est autorisé, pas filtré.
        String harness = "CREATE TABLE t (n INT);\n-- @student\nSELECT 1;";
        String content = onlyFileContent(assembler.assembleSqlPhase1("DROP TABLE t;\nCREATE TABLE t(n)", harness, "N"));
        assertThat(content).contains("DROP TABLE t");
    }

    @Test
    void sql_phase2_loads_data_then_fences_the_verdict() {
        String harness = "CREATE TABLE t (n INT);\n-- @student\nSELECT (SELECT count(*) FROM t) = 0;";
        String data = "CREATE TABLE t(n INT);\n;\nINSERT INTO t VALUES(1);\n;\n";
        String content = onlyFileContent(assembler.assembleSqlPhase2(data, harness, "N"));
        // Données d'abord, puis verdict encadré ; le code étudiant n'apparaît nulle part.
        assertThat(content.indexOf("INSERT INTO t VALUES(1)"))
                .isLessThan(content.indexOf("SELECT 'N_VERDICT_START'"));
        assertThat(content).contains("SELECT (SELECT count(*) FROM t) = 0");
    }

    @Test
    void sqlWorkingTables_lists_setup_tables_only() {
        String harness = "CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);\n"
                + "CREATE TABLE roles (id INT);\n-- @student\n"
                + "CREATE TEMP TABLE attendu (n INT);\nSELECT 1;"; // après le marqueur → PAS listée
        assertThat(CodeAssembler.sqlWorkingTables(harness)).containsExactlyInAnyOrder("utilisateurs", "roles");
    }

    @Test
    void filterDumpToData_keeps_only_whitelisted_tables_and_inserts() {
        // Dump réaliste du paquet Piston sqlite3 (contient la table de plomberie « argv »).
        String dump = "PRAGMA foreign_keys=OFF;\n"
                + "BEGIN TRANSACTION;\n"
                + "CREATE TABLE argv (arg text);\n"
                + "CREATE TABLE t(n INT);\n"
                + "INSERT INTO t VALUES(1);\n"
                + "CREATE TABLE triche(x INT);\n"       // table fabriquée par l'étudiant, hors liste
                + "INSERT INTO triche VALUES(9);\n"
                + "CREATE VIEW v AS SELECT * FROM t;\n"
                + "CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END;\n"
                + "COMMIT;\n";
        String data = CodeAssembler.filterDumpToData(dump, java.util.Set.of("t"));
        assertThat(data).contains("CREATE TABLE t(n INT)").contains("INSERT INTO t VALUES(1)");
        // Objets exécutables + transaction/PRAGMA : jetés.
        assertThat(data).doesNotContain("CREATE VIEW").doesNotContain("CREATE TRIGGER")
                .doesNotContain("PRAGMA").doesNotContain("BEGIN TRANSACTION").doesNotContain("COMMIT");
        // Hors liste blanche : plomberie « argv » ET table fabriquée par l'étudiant « triche ».
        assertThat(data).doesNotContain("argv").doesNotContain("triche");
    }

    @Test
    void run_returns_student_code_verbatim() {
        var a = assembler.assembleRun("Python", "print('hi')");
        assertThat(a.pistonLanguage()).isEqualTo("python");
        assertThat(onlyFileContent(a)).isEqualTo("print('hi')");
    }

    @Test
    void unsupported_language_throws() {
        assertThatThrownBy(() -> assembler.assemble("COBOL", "x", "y", "N"))
                .isInstanceOf(UnsupportedLanguageException.class);
    }

    @Test
    void null_code_and_harness_are_tolerated() {
        var a = assembler.assemble("Python", null, null, "N");
        assertThat(a.files()).isNotEmpty();
    }
}
