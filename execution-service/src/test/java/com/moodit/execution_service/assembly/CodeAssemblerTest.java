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
        assertThat(onlyFileContent(a)).contains("CREATE VIEW solution AS");
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
