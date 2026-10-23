package com.moodit.execution_service.assembly;

import com.moodit.execution_service.piston.PistonClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Compléments aux tests de {@link CodeAssemblerTest} (mêmes conventions : aucun Piston, on vérifie
 * le programme assemblé) : langages compilés non encore exercés (Go, Rust, C#), HTML (bundle
 * vendor), exécution simple (« run ») de chaque langage, alias, proxys de classes (JS/PHP) et cas
 * limites du découpage SQL. Quand c'est possible, on compare le programme assemblé EXACT : toute
 * modification de l'enveloppe (point d'entrée, émission du nonce, code de sortie) fait échouer.
 */
class CodeAssemblerLanguagesTest {

    private final CodeAssembler assembler = new CodeAssembler("/nonexistent-vendor");

    private static String onlyFileContent(CodeAssembler.Assembled a) {
        assertThat(a.files()).hasSize(1);
        return a.files().get(0).content();
    }

    // ── Langages compilés : programme exact ─────────────────────────────────────

    @Test
    void go_renomme_le_main_etudiant_et_emet_le_nonce_si_le_harnais_reussit() {
        var a = assembler.assemble("Go", "package main\n\nfunc solution() int { return 5 }\n\nfunc main() {}",
                "return solution() == 5", "MOODIT_OK_go");

        assertThat(a.pistonLanguage()).isEqualTo("go");
        assertThat(a.files()).extracting(PistonClient.File::name).containsExactly("main.go");
        assertThat(onlyFileContent(a)).isEqualTo(
                "package main\n\nfunc solution() int { return 5 }\n\nfunc __moodit_student_main() {}"
                        + "\n\nfunc __moodit_harness() bool {\n"
                        + "return solution() == 5"
                        + "\n}\n"
                        + "func main() {\n"
                        + "\tif __moodit_harness() {\n"
                        + "\t\tprint(\"MOODIT_OK_go\")\n"
                        + "\t}\n"
                        + "}\n");
    }

    @Test
    void rust_renomme_le_main_etudiant_meme_avec_espaces_et_emet_le_nonce_sur_stderr() {
        var a = assembler.assemble("Rust", "fn solution() -> i32 { 5 }\nfn  main ()  {}",
                "solution() == 5", "MOODIT_OK_rs");

        assertThat(a.pistonLanguage()).isEqualTo("rust");
        assertThat(a.files()).extracting(PistonClient.File::name).containsExactly("main.rs");
        assertThat(onlyFileContent(a)).isEqualTo(
                "fn solution() -> i32 { 5 }\nfn __moodit_student_main()  {}"
                        + "\n\nfn __moodit_harness() -> bool {\n"
                        + "solution() == 5"
                        + "\n}\n"
                        + "fn main() {\n"
                        + "    if __moodit_harness() {\n"
                        + "        eprint!(\"MOODIT_OK_rs\");\n"
                        + "    }\n"
                        + "}\n");
    }

    @Test
    void cpp_bascule_le_main_par_macro_et_capture_les_exceptions() {
        var a = assembler.assemble("C++", "int solution(){ return 5; }\nint main(){ return 0; }",
                "return solution() == 5;", "MOODIT_OK_cpp");

        assertThat(a.pistonLanguage()).isEqualTo("c++");
        assertThat(a.files()).extracting(PistonClient.File::name).containsExactly("main.cpp");
        assertThat(onlyFileContent(a)).isEqualTo(
                "#define main __moodit_student_main\n"
                        + "int solution(){ return 5; }\nint main(){ return 0; }"
                        + "\n#undef main\n"
                        + "#include <iostream>\n"
                        + "static bool __moodit_harness() {\n"
                        + "return solution() == 5;"
                        + "\n}\n"
                        + "int main() {\n"
                        + "    try {\n"
                        + "        if (__moodit_harness()) { std::cerr << \"MOODIT_OK_cpp\"; return 0; }\n"
                        + "        return 1;\n"
                        + "    } catch (...) { return 1; }\n"
                        + "}\n");
    }

    @Test
    void csharp_renomme_les_main_void_et_int_de_l_etudiant() {
        var a = assembler.assemble("C#",
                "class A { static void Main(string[] a) {} }\nclass B { static int Main () { return 0; } }",
                "return true;", "MOODIT_OK_cs");

        assertThat(a.pistonLanguage()).isEqualTo("csharp");
        assertThat(a.files()).extracting(PistonClient.File::name).containsExactly("main.cs");
        String program = onlyFileContent(a);
        assertThat(program)
                .startsWith("class A { static void __moodit_student_main(string[] a) {} }\n"
                        + "class B { static int __moodit_student_main () { return 0; } }")
                .contains("static bool __moodit_run() {\nreturn true;\n    }")
                .contains("if (__moodit_run()) { System.Console.Error.Write(\"MOODIT_OK_cs\"); return 0; }")
                .contains("catch (System.Exception __e) { System.Console.Error.WriteLine(__e); return 1; }");
        // Un SEUL point d'entrée subsiste : le nôtre.
        assertThat(program.split("static int Main\\(", -1)).hasSize(2);
        assertThat(program).doesNotContain("static void Main(");
    }

    // ── HTML (bundle vendor) ────────────────────────────────────────────────────

    @Test
    void html_fournit_le_parseur_embarque_et_la_soumission_intacte(@TempDir Path vendorDir) throws Exception {
        Files.writeString(vendorDir.resolve("htmlparser.js"), "module.exports = { parse: () => null };");
        var asm = new CodeAssembler(vendorDir.toString());

        var a = asm.assemble("HTML", "<h1>Bonjour</h1>", "return doc.querySelector('h1') !== null;", "MOODIT_OK_html");

        assertThat(a.pistonLanguage()).isEqualTo("javascript");
        assertThat(a.files()).extracting(PistonClient.File::name)
                .containsExactly("main.js", "htmlparser.js", "submission.html");
        assertThat(a.files().get(0).content())
                .contains("require('./htmlparser.js')")
                .contains("readFileSync(__dirname + '/submission.html', 'utf8')")
                .contains("function __moodit_harness() {\nreturn doc.querySelector('h1') !== null;\n}")
                .contains("if (__moodit_result) process.stderr.write(\"MOODIT_OK_html\");");
        assertThat(a.files().get(1).content()).isEqualTo("module.exports = { parse: () => null };");
        assertThat(a.files().get(2).content()).isEqualTo("<h1>Bonjour</h1>");
    }

    @Test
    void bundle_vendor_est_lu_une_seule_fois_puis_mis_en_cache(@TempDir Path vendorDir) throws Exception {
        Path bundle = vendorDir.resolve("htmlparser.js");
        Files.writeString(bundle, "// v1");
        var asm = new CodeAssembler(vendorDir.toString());
        asm.assemble("HTML", "<p></p>", "return true;", "N");

        // Le fichier disparaît : la 2e soumission réutilise le contenu mémorisé.
        Files.delete(bundle);
        var a = asm.assemble("HTML", "<p></p>", "return true;", "N");

        assertThat(a.files().get(1).content()).isEqualTo("// v1");
    }

    @Test
    void bundle_vendor_absent_leve_une_erreur_explicite() {
        assertThatThrownBy(() -> assembler.assemble("HTML", "<p></p>", "return true;", "N"))
                .isInstanceOf(UncheckedIOException.class)
                .hasMessage("Bundle d'exécution introuvable : htmlparser.js");
    }

    // ── Proxys de classes et filtrage des symboles internes ─────────────────────

    @Test
    void javascript_proxifie_les_classes_par_construction_rpc() {
        var a = assembler.assemble("JavaScript",
                "class Pile { constructor(){ this.e=[]; } }\nconst taille = (p) => 0;",
                "return new Pile() !== null;", "MOODIT_OK_c");
        String grader = a.files().get(0).content();

        assertThat(grader)
                .contains("const Pile = new Proxy(function(){}, { construct(_t,args){")
                .contains("__moodit_rpc({op:'new',cls:'Pile',args})")
                .contains("function taille(...a){ return __moodit_rpc({op:'call',name:'taille',args:a}).value; }")
                .doesNotContain("function Pile(...a)");      // une classe n'est pas proxifiée comme fonction
        assertThat(a.files().get(1).content()).contains("class Pile {").doesNotContain("MOODIT_OK_c");
    }

    @Test
    void php_proxifie_les_classes_y_compris_abstract_et_ignore_les_symboles_internes() {
        var a = assembler.assemble("PHP",
                "<?php\nclass Compteur { function inc(){ return 1; } }\nabstract class Base {}\n"
                        + "final class Fin {}\nfunction __moodit_y(){}\nclass __moodit_K {}",
                "return (new Compteur())->inc() === 1;", "MOODIT_OK_php");
        String grader = a.files().get(0).content();

        assertThat(grader)
                .contains("class Compteur { public $__moodit_h;\n")
                .contains("['op'=>'new','cls'=>'Compteur','args'=>$a]")
                .contains("class Base { public $__moodit_h;")
                .contains("class Fin { public $__moodit_h;")
                .contains("function __call($n, $a){ return __moodit_rpc(['op'=>'method'")
                .doesNotContain("function __moodit_y(...$a)")
                .doesNotContain("class __moodit_K {");
        assertThat(a.files().get(1).content()).startsWith("<?php\nclass Compteur").doesNotContain("MOODIT_OK_php");
    }

    @Test
    void python_ignore_les_fonctions_et_classes_internes_de_l_etudiant() {
        var a = assembler.assemble("Python",
                "def __moodit_rpc(x):\n    return 1\nclass __moodit_Faux:\n    pass\nasync def lire():\n    return 2",
                "return True", "MOODIT_OK_py");
        String grader = a.files().get(0).content();

        // Le vrai __moodit_rpc du noteur n'est pas écrasé par un proxy portant le même nom.
        assertThat(grader.split("def __moodit_rpc\\(", -1)).hasSize(2);
        assertThat(grader).doesNotContain("class __moodit_Faux")
                .contains("def lire(*a):\n    return __moodit_rpc({\"op\": \"call\", \"name\": \"lire\", \"args\": list(a)})[\"value\"]\n");
    }

    @Test
    void bash_ignore_les_fonctions_internes_et_accepte_le_mot_cle_function() {
        var a = assembler.assemble("Bash", "function doubler() { echo 2; }\n__moodit_rpc() { echo pirate; }",
                "[ \"$(doubler)\" = 2 ]", "MOODIT_OK_sh");
        String grader = a.files().get(0).content();

        assertThat(grader).contains("doubler() { __moodit_rpc doubler \"$@\"; }\n")
                .doesNotContain("__moodit_rpc() { __moodit_rpc")
                .endsWith("if __moodit_harness; then printf '%s' 'MOODIT_OK_sh' >&2; exit 0; else exit 1; fi\n");
        assertThat(a.files().get(1).content())
                .isEqualTo("function doubler() { echo 2; }\n__moodit_rpc() { echo pirate; }"
                        + "\nread -r __moodit_name __moodit_rest\n$__moodit_name $__moodit_rest\n");
    }

    // ── Alias et normalisation ──────────────────────────────────────────────────

    @ParameterizedTest(name = "{0} → {1}")
    @CsvSource({
            "node, javascript",
            "' Python ', python",
            "ts, typescript",
            "cplusplus, c++",
            "cs, csharp",
            "c-sharp, csharp",
            "shell, bash",
            "sh, bash",
            "golang, go",
            "sqlite, sqlite3",
            "SQLITE3, sqlite3",
    })
    void alias_de_langage_resolus_a_l_assemblage(String language, String pistonLanguage) {
        assertThat(assembler.assemble(language, "", "", "N").pistonLanguage()).isEqualTo(pistonLanguage);
    }

    @Test
    void langage_null_est_refuse() {
        assertThatThrownBy(() -> assembler.assemble(null, "x", "y", "N"))
                .isInstanceOf(UnsupportedLanguageException.class)
                .hasMessage("Langage non encore supporté par l'exécution : null");
        assertThatThrownBy(() -> assembler.assembleRun(null, "x"))
                .isInstanceOf(UnsupportedLanguageException.class);
    }

    @Test
    void isSql_reconnait_sql_et_ses_alias_seulement() {
        assertThat(CodeAssembler.isSql("SQL")).isTrue();
        assertThat(CodeAssembler.isSql(" SQLite ")).isTrue();
        assertThat(CodeAssembler.isSql("sqlite3")).isTrue();
        assertThat(CodeAssembler.isSql("Python")).isFalse();
        assertThat(CodeAssembler.isSql(null)).isFalse();
    }

    // ── Exécution simple (« run ») ──────────────────────────────────────────────

    @ParameterizedTest(name = "{0} → {1}/{2}")
    @CsvSource({
            "Python, python, main.py",
            "JavaScript, javascript, main.js",
            "js, javascript, main.js",
            "TypeScript, typescript, main.ts",
            "PHP, php, main.php",
            "Bash, bash, main.sh",
            "Go, go, main.go",
            "Rust, rust, main.rs",
            "C, c, main.c",
            "C++, c++, main.cpp",
            "C#, csharp, main.cs",
            "SQL, sqlite3, main.sql",
            "Java, java, Main.java",
    })
    void run_envoie_le_code_tel_quel_dans_le_fichier_attendu(String language, String pistonLanguage,
            String fileName) {
        String code = "// code étudiant de " + language;
        var a = assembler.assembleRun(language, code);

        assertThat(a.pistonLanguage()).isEqualTo(pistonLanguage);
        assertThat(a.files()).singleElement().satisfies(f -> {
            assertThat(f.name()).isEqualTo(fileName);
            assertThat(f.content()).isEqualTo(code);   // aucun harnais, aucune enveloppe
        });
    }

    @Test
    void run_java_nomme_le_fichier_d_apres_la_classe_publique() {
        var a = assembler.assembleRun("Java", "import java.util.*;\npublic   class Solution { public static void main(String[] a){} }");

        assertThat(a.files()).singleElement().satisfies(f -> assertThat(f.name()).isEqualTo("Solution.java"));
    }

    @Test
    void run_json_valide_et_reindente_sans_harnais() {
        var a = assembler.assembleRun("JSON", "{\"a\":1}");

        assertThat(a.pistonLanguage()).isEqualTo("javascript");
        assertThat(a.files()).extracting(PistonClient.File::name).containsExactly("main.js", "submission.json");
        assertThat(a.files().get(0).content())
                .contains("console.log(JSON.stringify(data, null, 2));")
                .contains("console.error('JSON invalide: '")
                .contains("process.exit(1);")
                .doesNotContain("__moodit_harness");
        assertThat(a.files().get(1).content()).isEqualTo("{\"a\":1}");
    }

    @Test
    void run_code_null_devient_vide() {
        assertThat(onlyFileContent(assembler.assembleRun("Python", null))).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {"HTML", "JSX", "TSX", "COBOL"})
    void run_refuse_les_langages_non_executables_seuls(String language) {
        // HTML/JSX/TSX ne s'exécutent qu'à travers un harnais (pas de « play » brut).
        assertThatThrownBy(() -> assembler.assembleRun(language, "x"))
                .isInstanceOf(UnsupportedLanguageException.class)
                .hasMessageContaining(language);
    }

    // ── SQL : programmes exacts et cas limites ──────────────────────────────────

    @Test
    void sql_sans_requete_etudiante_ne_cree_aucune_vue() {
        var a = assembler.assemble("SQL", "  -- rien\n", "SELECT 1;", "N");

        assertThat(onlyFileContent(a)).isEqualTo(
                "\nSELECT 'N_VERDICT_START';\nSELECT 1;\n;\nSELECT 'N_VERDICT_END';\n");
    }

    @Test
    void sql_lecture_seule_programme_exact() {
        var a = assembler.assemble("SQL", "SELECT 1; SELECT 2", "SELECT 1;", "N");

        assertThat(onlyFileContent(a)).isEqualTo(
                "CREATE VIEW solution1 AS\nSELECT 1\n;\n"
                        + "CREATE VIEW solution2 AS\nSELECT 2\n;\n"
                        + "CREATE VIEW solution AS SELECT * FROM solution1;\n"
                        + "\nSELECT 'N_VERDICT_START';\nSELECT 1;\n;\nSELECT 'N_VERDICT_END';\n");
    }

    @Test
    void phase1_sans_marqueur_ajoute_un_saut_de_ligne_apres_le_setup() {
        var a = assembler.assembleSqlPhase1("UPDATE t SET n = 0", "CREATE TABLE t(n INT);", "N");

        assertThat(onlyFileContent(a)).isEqualTo(
                "CREATE TABLE t(n INT);\nUPDATE t SET n = 0\n;\n"
                        + "SELECT 'N_DUMP_START';\n.dump\nSELECT 'N_DUMP_END';\n");
    }

    @Test
    void phase1_tolere_code_et_harnais_nuls() {
        var a = assembler.assembleSqlPhase1(null, null, "N");

        assertThat(onlyFileContent(a)).isEqualTo("\n;\nSELECT 'N_DUMP_START';\n.dump\nSELECT 'N_DUMP_END';\n");
    }

    @Test
    void phase2_termine_les_donnees_par_un_saut_de_ligne_et_ne_garde_que_le_verdict() {
        var a = assembler.assembleSqlPhase2("INSERT INTO t VALUES(1)",
                "CREATE TABLE t(n INT);\n-- @student\nSELECT count(*) = 1 FROM t;", "N");

        assertThat(onlyFileContent(a)).isEqualTo(
                "INSERT INTO t VALUES(1)\n"
                        + "SELECT 'N_VERDICT_START';\n\nSELECT count(*) = 1 FROM t;\n;\nSELECT 'N_VERDICT_END';\n");
    }

    @Test
    void phase2_sans_marqueur_utilise_tout_le_harnais_et_tolere_les_nuls() {
        assertThat(onlyFileContent(assembler.assembleSqlPhase2(null, null, "N")))
                .isEqualTo("SELECT 'N_VERDICT_START';\n\n;\nSELECT 'N_VERDICT_END';\n");
        assertThat(onlyFileContent(assembler.assembleSqlPhase2("", "SELECT 1;", "N")))
                .isEqualTo("SELECT 'N_VERDICT_START';\nSELECT 1;\n;\nSELECT 'N_VERDICT_END';\n");
    }

    @Test
    void sqlWorkingTables_tolere_null_et_normalise_les_noms() {
        assertThat(CodeAssembler.sqlWorkingTables(null)).isEmpty();
        // Sans marqueur : tout le harnais est du setup ; noms délimités et casse normalisés.
        assertThat(CodeAssembler.sqlWorkingTables(
                "CREATE TABLE IF NOT EXISTS \"Notes\"(n INT);\ncreate table [Eleves](id INT);"))
                .containsExactlyInAnyOrder("notes", "eleves");
    }

    @Test
    void filterDumpToData_garde_insert_or_replace_et_noms_delimites() {
        String dump = "CREATE TABLE IF NOT EXISTS [T](n INT);\n"
                + "INSERT OR REPLACE INTO \"T\" VALUES(1);\n"
                + "CREATE INDEX i ON T(n);\n";

        assertThat(CodeAssembler.filterDumpToData(dump, Set.of("t"))).isEqualTo(
                "CREATE TABLE IF NOT EXISTS [T](n INT)\n;\nINSERT OR REPLACE INTO \"T\" VALUES(1)\n;\n");
        assertThat(CodeAssembler.filterDumpToData("", Set.of("t"))).isEmpty();
    }

    @Test
    void splitSqlStatements_null_donne_une_liste_vide() {
        assertThat(CodeAssembler.splitSqlStatements(null)).isEmpty();
    }

    @Test
    void splitSqlStatements_point_virgule_dans_un_commentaire_de_bloc_n_est_pas_un_separateur() {
        assertThat(CodeAssembler.splitSqlStatements("SELECT 1 /* ; */ FROM t; SELECT 2"))
                .containsExactly("SELECT 1 /* ; */ FROM t", "SELECT 2");
    }

    @Test
    void splitSqlStatements_commentaire_de_bloc_non_ferme_avale_la_fin() {
        assertThat(CodeAssembler.splitSqlStatements("SELECT 1 /* ; SELECT 2"))
                .containsExactly("SELECT 1 /* ; SELECT 2");
    }

    @Test
    void splitSqlStatements_commentaire_de_ligne_final_sans_saut_de_ligne() {
        assertThat(CodeAssembler.splitSqlStatements("SELECT 1; -- fin ; pas une instruction"))
                .containsExactly("SELECT 1");
    }

    @Test
    void splitSqlStatements_identifiant_crochete_protege_le_point_virgule() {
        assertThat(CodeAssembler.splitSqlStatements("SELECT [a;b] FROM t; SELECT 2"))
                .containsExactly("SELECT [a;b] FROM t", "SELECT 2");
        // Crochet non fermé : on prend jusqu'au bout.
        assertThat(CodeAssembler.splitSqlStatements("SELECT [a;b"))
                .containsExactly("SELECT [a;b");
    }

    @Test
    void splitSqlStatements_guillemet_double_echappe_ne_ferme_pas_la_chaine() {
        assertThat(CodeAssembler.splitSqlStatements("SELECT 'l''a;b'; SELECT \"x\"\"y;z\"; SELECT `q;r`"))
                .containsExactly("SELECT 'l''a;b'", "SELECT \"x\"\"y;z\"", "SELECT `q;r`");
    }

    @Test
    void splitSqlStatements_chaine_non_fermee_prend_jusqu_au_bout() {
        assertThat(CodeAssembler.splitSqlStatements("SELECT 'abc; SELECT 2"))
                .containsExactly("SELECT 'abc; SELECT 2");
    }

    @Test
    void sql_une_chaine_non_fermee_reste_confinee_dans_sa_vue() {
        // Un littéral non fermé ne peut pas « déborder » : toute la suite reste dans solution1.
        var a = assembler.assemble("SQL", "SELECT 'x; DROP TABLE t", "SELECT 1;", "N");

        assertThat(onlyFileContent(a))
                .startsWith("CREATE VIEW solution1 AS\nSELECT 'x; DROP TABLE t\n;\n")
                .doesNotContain("solution2");
    }
}
