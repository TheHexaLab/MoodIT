package com.moodit.execution_service.assembly;

import com.moodit.execution_service.piston.PistonClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Compléments aux tests de {@link CodeAssemblerTest} (mêmes conventions : aucun Piston, on vérifie
 * le programme assemblé) : langages compilés non encore exercés (Go, Rust, C#), HTML (bundle
 * vendor), exécution simple (« run ») de chaque langage, alias, proxys de classes (JS/PHP) et cas
 * limites du découpage SQL. Pour les langages compilés, on vérifie des PROPRIÉTÉS (point d'entrée
 * unique, code étudiant intact, harnais et nonce dans le noteur) plutôt que le texte exact ; le
 * fait que le programme s'exécute et note correctement relève d'ExecutionIntegrationTest.
 */
class CodeAssemblerLanguagesTest {

    private final CodeAssembler assembler = new CodeAssembler("/nonexistent-vendor");

    private static String onlyFileContent(CodeAssembler.Assembled a) {
        assertThat(a.files()).hasSize(1);
        return a.files().get(0).content();
    }

    // ── Langages compilés : propriétés du programme assemblé ────────────────────
    //
    // On ne compare plus le programme caractère par caractère (fragile, et ça ne prouve pas qu'il
    // s'exécute : c'est le rôle d'ExecutionIntegrationTest contre un vrai Piston). On vérifie les
    // INVARIANTS dont dépend la correction : un seul point d'entrée (le nôtre), le code étudiant
    // présent tel quel (au renommage de son main près), le harnais intact dans sa fonction, le nonce
    // émis une seule fois, par notre main, APRÈS l'appel du harnais, et aucun code étudiant dans la
    // partie « noteur ». Un harnais = un programme : le nonce est le marqueur propre à chaque test.

    /**
     * Cas d'un langage compilé. {@code studentSegment} = code étudiant attendu dans le programme
     * (identique à la soumission pour C/C++, main renommé ailleurs) ; {@code macroGuard} = le main
     * étudiant est neutralisé par {@code #define main} (C/C++) plutôt que par renommage.
     */
    private record Compiled(String language, String pistonLanguage, String fileName, String studentCode,
            String studentSegment, String harness, String harnessSignature, String harnessCall,
            String entryPoint, boolean macroGuard) {
        @Override
        public String toString() {
            return language;
        }
    }

    private static final String MARK = "ETUDIANT_SEULEMENT";
    private static final String NONCE = "MOODIT_OK_n0nce";

    static Stream<Compiled> compiledLanguages() {
        return Stream.of(
                new Compiled("Go", "go", "main.go",
                        "package main\n\n// " + MARK + "\nfunc solution() int { return 5 }\n\nfunc main() {}",
                        "package main\n\n// " + MARK + "\nfunc solution() int { return 5 }\n\nfunc __moodit_student_main() {}",
                        "return solution() == 5", "func __moodit_harness() bool {", "__moodit_harness()",
                        "func\\s+main\\s*\\(", false),
                // Espaces autour de « main » : le renommage doit quand même s'appliquer.
                new Compiled("Rust", "rust", "main.rs",
                        "// " + MARK + "\nfn solution() -> i32 { 5 }\nfn  main ()  {}",
                        "// " + MARK + "\nfn solution() -> i32 { 5 }\nfn __moodit_student_main()  {}",
                        "solution() == 5", "fn __moodit_harness() -> bool {", "__moodit_harness()",
                        "fn\\s+main\\s*\\(", false),
                new Compiled("C", "c", "main.c",
                        "/* " + MARK + " */\nint solution(void){ return 5; }\nint main(void){ return 0; }",
                        "/* " + MARK + " */\nint solution(void){ return 5; }\nint main(void){ return 0; }",
                        "return solution() == 5;", "static int __moodit_harness(void) {", "__moodit_harness()",
                        "int\\s+main\\s*\\(", true),
                new Compiled("C++", "c++", "main.cpp",
                        "// " + MARK + "\nint solution(){ return 5; }\nint main(){ return 0; }",
                        "// " + MARK + "\nint solution(){ return 5; }\nint main(){ return 0; }",
                        "return solution() == 5;", "static bool __moodit_harness() {", "__moodit_harness()",
                        "int\\s+main\\s*\\(", true),
                // Les deux formes de Main (void et int) doivent être renommées.
                new Compiled("C#", "csharp", "main.cs",
                        "// " + MARK + "\nclass A { static void Main(string[] a) {} }\n"
                                + "class B { static int Main () { return 0; } }",
                        "// " + MARK + "\nclass A { static void __moodit_student_main(string[] a) {} }\n"
                                + "class B { static int __moodit_student_main () { return 0; } }",
                        "return true;", "static bool __moodit_run() {", "__moodit_run()",
                        "static\\s+(?:void|int)\\s+Main\\s*\\(", false),
                new Compiled("Java", "java", "Main.java",
                        "// " + MARK + "\nclass Solution { static int solution(){ return 5; } "
                                + "public static void main(String[] a){} }",
                        "// " + MARK + "\nclass Solution { static int solution(){ return 5; } "
                                + "public static void __moodit_student_main(String[] a){} }",
                        "return Solution.solution() == 5;", "static boolean __moodit_harness() {",
                        "__moodit_harness()", "static\\s+void\\s+main\\s*\\(\\s*String", false));
    }

    private static int occurrences(String text, String needle) {
        return text.split(Pattern.quote(needle), -1).length - 1;
    }

    private static int matches(String regex, String text) {
        return (int) Pattern.compile(regex).matcher(text).results().count();
    }

    /** Programme assemblé, découpé en segment étudiant et partie « noteur » (tout le reste). */
    private record Split(String program, int studentStart, int studentEnd) {
        String grader() {
            return program.substring(0, studentStart) + program.substring(studentEnd);
        }
    }

    private Split assembleCompiled(Compiled c) {
        var a = assembler.assemble(c.language(), c.studentCode(), c.harness(), NONCE);
        assertThat(a.pistonLanguage()).isEqualTo(c.pistonLanguage());
        assertThat(a.files()).extracting(PistonClient.File::name).containsExactly(c.fileName());
        String program = onlyFileContent(a);
        // Le code étudiant figure une seule fois, tel quel (main renommé le cas échéant).
        assertThat(occurrences(program, c.studentSegment())).isEqualTo(1);
        int start = program.indexOf(c.studentSegment());
        return new Split(program, start, start + c.studentSegment().length());
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("compiledLanguages")
    void compile_un_seul_point_d_entree_et_le_code_etudiant_intact(Compiled c) {
        Split s = assembleCompiled(c);

        // Exactement UN point d'entrée effectif : le nôtre, dans la partie noteur.
        assertThat(matches(c.entryPoint(), s.grader())).isEqualTo(1);
        if (c.macroGuard()) {
            // C/C++ : le main étudiant reste dans le texte, mais encadré par la macro qui le renomme.
            assertThat(s.program().substring(0, s.studentStart())).isEqualTo("#define main __moodit_student_main\n");
            assertThat(s.program().substring(s.studentEnd())).startsWith("\n#undef main\n");
        } else {
            assertThat(matches(c.entryPoint(), c.studentSegment())).isZero();
        }

        // Aucun fragment étudiant dans le noteur, ni harnais/nonce dans le segment étudiant.
        assertThat(s.grader()).doesNotContain(MARK);
        assertThat(c.studentSegment()).doesNotContain(NONCE).doesNotContain(c.harness());
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("compiledLanguages")
    void compile_harnais_intact_et_nonce_emis_par_notre_main_apres_le_harnais(Compiled c) {
        Split s = assembleCompiled(c);
        String grader = s.grader();

        // Le harnais est le corps exact de SA fonction, dans le noteur.
        assertThat(occurrences(grader, c.harnessSignature() + "\n" + c.harness() + "\n")).isEqualTo(1);

        // Notre main appelle le harnais, puis seulement émet le nonce (une seule émission en tout).
        assertThat(occurrences(s.program(), NONCE)).isEqualTo(1);
        Matcher entry = Pattern.compile(c.entryPoint()).matcher(grader);
        assertThat(entry.find()).isTrue();
        int callAt = grader.indexOf(c.harnessCall(), entry.end());
        assertThat(callAt).isPositive();
        assertThat(grader.indexOf(NONCE)).isGreaterThan(callAt);
    }

    @Test
    void java_notre_classe_d_entree_vient_en_premier() {
        // Mode fichier-source unique (JEP 330) : la PREMIÈRE classe porte le main exécuté.
        String program = onlyFileContent(assembler.assemble("Java",
                "public class Main { public static void main(String[] a){} }", "return true;", "N"));

        assertThat(program).startsWith("public class __MooditMain {");
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
