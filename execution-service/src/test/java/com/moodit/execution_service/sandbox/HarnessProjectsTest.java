package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.TestCaseInput;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Dispositions de projet par langage envoyées au runner (#116) : structure, canaris, job.json. */
class HarnessProjectsTest {

    private static final List<TestCaseInput> ONE_CASE =
            List.of(new TestCaseInput("aire du rectangle", "HARNAIS", 2));

    @Test
    void runner_language_resout_les_alias_et_rejette_les_interpretes() {
        assertThat(HarnessProjects.runnerLanguage("Java")).isEqualTo("java");
        assertThat(HarnessProjects.runnerLanguage("C#")).isEqualTo("csharp");
        assertThat(HarnessProjects.runnerLanguage("cs")).isEqualTo("csharp");
        assertThat(HarnessProjects.runnerLanguage("golang")).isEqualTo("go");
        assertThat(HarnessProjects.runnerLanguage("C++")).isEqualTo("cpp");
        assertThat(HarnessProjects.runnerLanguage("cplusplus")).isEqualTo("cpp");
        assertThatThrownBy(() -> HarnessProjects.runnerLanguage("Python"))
                .isInstanceOf(UnsupportedLanguageException.class);
    }

    @Test
    void java_nomme_les_fichiers_selon_la_classe_publique() {
        HarnessProjects.Project project = HarnessProjects.build("Java",
                "public class Solution { }",
                List.of(new TestCaseInput("t", "class MonHarnais { }", 1)), null);
        assertThat(project.files()).containsKey("cases/0/src/Solution.java");
        assertThat(project.files()).containsKey("cases/0/src/MonHarnais.java");
    }

    @Test
    void java_fallback_quand_aucune_classe_detectee() {
        assertThat(HarnessProjects.javaFileName("du texte sans classe", "Solution"))
                .isEqualTo("Solution.java");
        assertThat(HarnessProjects.javaFileName("record Point(int x) { }", "S")).isEqualTo("Point.java");
    }

    @Test
    void go_pose_module_code_et_test_dans_le_meme_package() {
        HarnessProjects.Project project = HarnessProjects.build("Go", "package main", ONE_CASE, null);
        assertThat(project.files().get("cases/0/src/go.mod")).contains("module moodit");
        assertThat(project.files().get("cases/0/src/main.go")).isEqualTo("package main");
        assertThat(project.files().get("cases/0/src/solution_test.go")).isEqualTo("HARNAIS");
    }

    @Test
    void rust_concatene_etudiant_et_module_de_tests() {
        HarnessProjects.Project project = HarnessProjects.build("Rust", "fn main() {}", ONE_CASE, null);
        assertThat(project.files().get("cases/0/src/Cargo.toml")).contains("name = \"moodit\"");
        assertThat(project.files().get("cases/0/src/src/lib.rs"))
                .startsWith("fn main() {}").contains("HARNAIS");
    }

    @Test
    void c_et_cpp_incluent_l_etudiant_avec_main_neutralise() {
        for (String language : List.of("C", "C++")) {
            String ext = language.equals("C") ? "c" : "cpp";
            HarnessProjects.Project project = HarnessProjects.build(language, "CODE", ONE_CASE, null);
            assertThat(project.files().get("cases/0/src/solution." + ext)).isEqualTo("CODE");
            String harness = project.files().get("cases/0/src/harness." + ext);
            assertThat(harness)
                    .contains("#define main __moodit_student_main")
                    .contains("#include \"solution." + ext + "\"")
                    .contains("#undef main")
                    .contains("#include <moodit_check.h>")
                    .contains("HARNAIS");
        }
    }

    @Test
    void csharp_genere_le_point_d_entree_nunitlite() {
        HarnessProjects.Project project = HarnessProjects.build("C#", "CODE", ONE_CASE, null);
        assertThat(project.files().get("cases/0/src/solution.cs")).isEqualTo("CODE");
        assertThat(project.files().get("cases/0/src/harness.cs")).isEqualTo("HARNAIS");
        assertThat(project.files().get("cases/0/src/moodit_runner.cs"))
                .contains("class MooditRunner").contains("NUnitLite.AutoRun");
    }

    @Test
    void chaque_disposition_porte_le_jeton_de_fin_d_execution() {
        // Le gabarit __MOODIT_T__ (substitué par le superviseur) doit être émis par le POINT DE
        // SORTIE du framework de chaque langage — c'est lui qui trahit un forgeage déclenché
        // depuis la fonction notée (invisible aux canaris).
        assertThat(HarnessProjects.build("Java", "class Solution {}", ONE_CASE, null).files()
                .get("cases/0/src/MooditEnveloppe.java")).contains("jeton=__MOODIT_T__");
        assertThat(HarnessProjects.build("C#", "CODE", ONE_CASE, null).files()
                .get("cases/0/src/moodit_runner.cs")).contains("jeton=__MOODIT_T__");
        assertThat(HarnessProjects.build("Go", "package main", ONE_CASE, null).files()
                .get("cases/0/src/moodit_main_test.go")).contains("jeton=__MOODIT_T__");
        assertThat(HarnessProjects.build("Rust", "fn main() {}", ONE_CASE, null).files()
                .get("cases/0/src/src/lib.rs")).contains("zzzz_moodit_jeton");
        assertThat(HarnessProjects.build("C", "CODE", ONE_CASE, null).files()
                .get("cases/0/src/harness.c")).contains("#define MOODIT_JETON \"__MOODIT_T__\"");
    }

    @Test
    void enveloppe_java_decalee_si_une_classe_etudiante_porte_son_nom() {
        HarnessProjects.Project project = HarnessProjects.build("Java",
                "public class MooditEnveloppe { }", ONE_CASE, null);
        // Le code étudiant garde son fichier ; l'enveloppe est décalée, rien n'est écrasé.
        assertThat(project.files().get("cases/0/src/MooditEnveloppe.java"))
                .isEqualTo("public class MooditEnveloppe { }");
        assertThat(project.files().get("cases/0/src/MooditEnveloppe_moodit.java"))
                .contains("jeton=__MOODIT_T__");
    }

    @Test
    void deux_canaris_embarquant_le_code_etudiant_sont_ajoutes() {
        HarnessProjects.Project project = HarnessProjects.build("Go", "package main", ONE_CASE, 5000);
        // Cas réels 0..N-1, canaris N (pass) et N+1 (fail), chacun AVEC le code étudiant.
        assertThat(project.files().get("cases/1/src/main.go")).isEqualTo("package main");
        assertThat(project.files().get("cases/1/src/solution_test.go"))
                .contains("__MOODIT_A__").contains("__MOODIT_B__");
        assertThat(project.files().get("cases/2/src/solution_test.go")).contains("__MOODIT_A__");
        // Le NOM du test canari est lui aussi un gabarit substitué au runtime (anti-reconnaissance).
        assertThat(project.files().get("cases/1/src/solution_test.go")).contains("Test__MOODIT_N__");
        String job = project.files().get("job.json");
        assertThat(job).contains("\"timeout_ms\":5000")
                .contains("{\"index\":1,\"canary\":\"pass\"}")
                .contains("{\"index\":2,\"canary\":\"fail\"}");
        assertThat(project.caseCount()).isEqualTo(1);
    }

    @Test
    void job_json_echappe_les_noms_de_cas() {
        HarnessProjects.Project project = HarnessProjects.build("Java", "class A {}",
                List.of(new TestCaseInput("nom \"piégé\"\navec\tsaut", "h", 1),
                        new TestCaseInput("anti\\slash\rretour\u0001contrôle", "h", 1)), null);
        assertThat(project.files().get("job.json"))
                .contains("\"name\":\"nom \\\"piégé\\\"\\navec\\tsaut\"")
                .contains("\"name\":\"anti\\\\slash\\rretour\\u0001contrôle\"");
    }

    @Test
    void chaque_langage_a_un_gabarit_de_canari() {
        for (String language : List.of("Java", "C#", "Go", "Rust", "C", "C++")) {
            Map<String, String> files = HarnessProjects.build(language, "code", ONE_CASE, null).files();
            boolean canaryPresent = files.entrySet().stream()
                    .anyMatch(e -> e.getKey().startsWith("cases/1/") && e.getValue().contains("__MOODIT_A__"));
            assertThat(canaryPresent).as("canari de " + language).isTrue();
        }
    }
}
