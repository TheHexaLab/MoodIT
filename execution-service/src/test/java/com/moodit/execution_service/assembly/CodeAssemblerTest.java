package com.moodit.execution_service.assembly;

import com.moodit.execution_service.piston.PistonClient;
import org.junit.jupiter.api.Test;

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
    void python_contains_student_harness_and_nonce() {
        var a = assembler.assemble("Python", "def solution():\n    return 5",
                "return solution() == 5", "MOODIT_OK_deadbeef");
        assertThat(a.pistonLanguage()).isEqualTo("python");
        var file = a.files().get(0);
        assertThat(file.name()).isEqualTo("main.py");
        assertThat(file.content())
                .contains("def solution()")            // code étudiant présent
                .contains("return solution() == 5")     // harnais présent
                .contains("__moodit_harness")           // enveloppe du harnais
                .contains("MOODIT_OK_deadbeef");        // nonce anti-triche injecté
    }

    @Test
    void java_puts_our_entry_first_and_renames_student_main() {
        var a = assembler.assemble("Java",
                "public class Solution { public static int solution(){ return 5; } "
                        + "public static void main(String[] a){} }",
                "return Solution.solution() == 5;", "MOODIT_OK_java");
        assertThat(a.pistonLanguage()).isEqualTo("java");
        String c = onlyFileContent(a);
        assertThat(c).startsWith("public class __MooditMain");   // notre classe d'entrée en 1er
        assertThat(c).contains("__moodit_student_main");         // main étudiant neutralisé
        assertThat(c).contains("MOODIT_OK_java");
    }

    @Test
    void c_neutralizes_main_via_macro() {
        var a = assembler.assemble("C", "int solution(void){ return 5; }",
                "return solution() == 5;", "MOODIT_OK_c");
        String c = onlyFileContent(a);
        assertThat(c).contains("#define main __moodit_student_main");
        assertThat(c).contains("#undef main");
        assertThat(c).contains("MOODIT_OK_c");
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
        assertThat(a.files()).hasSize(1);
    }
}
