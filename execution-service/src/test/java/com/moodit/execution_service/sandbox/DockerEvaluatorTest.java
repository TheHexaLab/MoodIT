package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Traduction FAIL-CLOSED du JSON du superviseur en verdicts (#116) : un cas sans verdict, un JSON
 * cassé ou une erreur du superviseur ne deviennent jamais un « réussi » ; les événements de
 * détection sont annexés au détail du cas visé.
 */
class DockerEvaluatorTest {

    private final DockerSandbox sandbox = mock(DockerSandbox.class);
    private final DockerEvaluator evaluator = new DockerEvaluator(sandbox, "moodit-runner-", "latest");

    private static final List<TestCaseInput> TWO_CASES = List.of(
            new TestCaseInput("premier", "h1", 2),
            new TestCaseInput("second", "h2", 3));

    private void supervisorReturns(String json) {
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun(json, "", 0));
    }

    @Test
    void mappe_les_verdicts_par_index_avec_noms_et_poids() {
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"name":"premier","passed":true,"detail":null,"ms":10},
                  {"index":1,"name":"second","passed":false,"detail":"attendu 12","ms":20}
                ],"events":[],"canaries":"ok"}
                """);
        List<TestResult> results = evaluator.evaluate("Go", "code", TWO_CASES, null);
        assertThat(results).containsExactly(
                new TestResult("premier", 2, true, null),
                new TestResult("second", 3, false, "attendu 12"));
    }

    @Test
    void cas_sans_verdict_echoue_fail_closed() {
        supervisorReturns("""
                {"v":1,"results":[{"index":0,"passed":true,"ms":1}],"events":[],"canaries":"ok"}
                """);
        List<TestResult> results = evaluator.evaluate("Go", "code", TWO_CASES, null);
        assertThat(results.get(0).passed()).isTrue();
        assertThat(results.get(1).passed()).isFalse();
        assertThat(results.get(1).detail()).contains("Notation incomplète");
    }

    @Test
    void json_illisible_leve_sandbox_exception() {
        // stderr volumineux : tronqué dans le journal, jamais dans l'exception.
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun("pas du json", "x".repeat(5000), 1));
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(SandboxException.class);
        // stderr absent : le journal reste robuste (aucune NPE).
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun("toujours pas du json", null, 1));
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(SandboxException.class);
    }

    @Test
    void evenement_non_suspect_avec_cas_ne_marque_pas_le_verdict() {
        supervisorReturns("""
                {"v":1,"results":[{"index":0,"passed":true,"ms":1},{"index":1,"passed":true,"ms":1}],
                 "events":[{"type":"trace_indisponible","case":0}],"canaries":"ok"}
                """);
        List<TestResult> results = evaluator.evaluate("Go", "code", TWO_CASES, null);
        assertThat(results.get(0).detail()).isNull();
    }

    @Test
    void sommaire_duplique_refuse_le_cas_sans_accuser_de_triche() {
        // CLIQUET contre la régression qui est revenue à chaque tour de revue : un sommaire
        // authentifié imprimé deux fois (un `fork()` honnête de la fonction notée y suffit, le
        // sommaire étant imprimé après la boucle de tests) doit REFUSER le cas sans bandeau de
        // falsification. La propriété n'était verrouillée que par un test d'intégration, qui
        // s'ignore en silence sans démon Docker : ajouter `sommaire_duplique` à isSuspicious
        // passait donc inaperçu en local. Ici, ça rougit dès `./gradlew test`.
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"passed":false,"detail":"Verdict indisponible : le sommaire du framework a été imprimé plusieurs fois (processus dupliqué ?)","ms":1},
                  {"index":1,"passed":true,"detail":null,"ms":1}
                ],"events":[
                  {"type":"sommaire_duplique","case":0,"detail":"sommaire authentifié imprimé plusieurs fois (processus dupliqué ?)"}
                ],"canaries":"ok"}
                """);
        List<TestResult> results = evaluator.evaluate("C", "code", TWO_CASES, null);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail())
                .contains("imprimé plusieurs fois")
                .doesNotContain("⚠").doesNotContain("suspect").doesNotContain("falsification");
        // Et le cas voisin n'est pas contaminé : l'événement ne vise que le cas 0.
        assertThat(results.get(1).passed()).isTrue();
        assertThat(results.get(1).detail()).isNull();
    }

    @Test
    void erreur_du_superviseur_leve_sandbox_exception() {
        supervisorReturns("{\"v\":1,\"error\":\"fichiers du job non reçus\"}");
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(SandboxException.class)
                .hasMessageContaining("fichiers du job non reçus");
    }

    @Test
    void evenement_suspect_annexe_au_detail_du_cas_vise() {
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"passed":true,"detail":null,"ms":1},
                  {"index":1,"passed":false,"detail":"échec","ms":1}
                ],"events":[
                  {"type":"lecture_source_tentee","case":0,"detail":"openat(src/harness.c)"},
                  {"type":"trace_indisponible"}
                ],"canaries":"ok"}
                """);
        List<TestResult> results = evaluator.evaluate("C", "code", TWO_CASES, null);
        // Une lecture détectée FAIT ÉCHOUER le cas, même « réussi » côté framework : lire son
        // binaire de test peut réussir (extraction du jeton) — annoter ne suffisait pas.
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("⚠ Comportement suspect")
                .contains("cas refusé").contains("lecture_source_tentee");
        // trace_indisponible (événement d'environnement, pas de triche) n'alerte pas le cas 1.
        assertThat(results.get(1).detail()).isEqualTo("échec");
    }

    @Test
    void image_cpp_partage_celle_du_c() {
        assertThat(evaluator.imageFor("cpp")).isEqualTo("moodit-runner-c:latest");
        assertThat(evaluator.imageFor("java")).isEqualTo("moodit-runner-java:latest");
    }

    @Test
    void budget_mural_borne_et_image_du_langage_utilisee() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // Harnais au format FRAMEWORK : UNE compilation par cas.
        evaluator.evaluate("C++", "code",
                List.of(new TestCaseInput("t", "MOODIT_TEST(t) { }", 1)), 5000);
        // 30 s de base + (1 cas + 2 canaris) × (5 s + 10 s de marge + 90 s de compilation PAR
        // CAS — chaque cas recompile son harnais — + 5 s d'inventaire `--list`) = 360 s.
        verify(sandbox).run(eq("moodit-runner-c:latest"), anyMap(), eq(360_000L));
    }

    @Test
    void temps_limite_aberrant_borne_jamais_de_mur_negatif() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // Négatif (valeur stockée aberrante) : borné à 1 ms, puis PLANCHER VM (10 s — miroir
        // du superviseur, JVM froide) — le mur reste positif et couvre le temps réel accordé.
        evaluator.evaluate("Java", "code",
                List.of(new TestCaseInput("t", "@Test void t() {}", 1)), -100_000);
        verify(sandbox).run(eq("moodit-runner-java:latest"), anyMap(), eq(375_000L));

        // Au-delà du plafond de l'éditeur (60 s) : ramené à 60 s par cas.
        evaluator.evaluate("Go", "code",
                List.of(new TestCaseInput("t", "func TestT(t *testing.T) {}", 1)), 999_999);
        verify(sandbox).run(eq("moodit-runner-go:latest"), anyMap(), eq(525_000L));
    }

    @Test
    void mur_couvre_les_compilations_reelles_du_chemin_non_falsifiable() {
        // Le chemin booléen compile DEUX programmes par cas — le noteur et le code soumis — et
        // TROIS en Java, où les signatures sont lues sur les classes compilées. Le mur n'en
        // budgétait qu'une : un cas lancé juste avant l'échéance du budget pouvait être tué au
        // mur, ce qui perdait tous les verdicts du job (502, tentative supprimée : #216).
        assertThat(DockerEvaluator.compilesPerCase("cpp",
                List.of(new TestCaseInput("t", "MOODIT_TEST(t) { }", 1)))).isEqualTo(1);
        assertThat(DockerEvaluator.compilesPerCase("cpp",
                List.of(new TestCaseInput("t", "return doubler(5) == 10;", 1)))).isEqualTo(2);
        assertThat(DockerEvaluator.compilesPerCase("java",
                List.of(new TestCaseInput("t", "return Solution.doubler(5) == 10;", 1))))
                .isEqualTo(3);
        // Un SEUL cas booléen suffit à payer le pire cas : le superviseur choisit cas par cas.
        assertThat(DockerEvaluator.compilesPerCase("go", List.of(
                new TestCaseInput("a", "func TestA(t *testing.T) {}", 1),
                new TestCaseInput("b", "return doubler(5) == 10", 1)))).isEqualTo(2);

        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        evaluator.evaluate("C++", "code",
                List.of(new TestCaseInput("t", "return doubler(5) == 10;", 1)), 5000);
        // 30 s + 3 × (5 s + 10 s + 2 × 90 s + 5 s) = 630 s, contre 360 s pour le framework.
        verify(sandbox).run(eq("moodit-runner-c:latest"), anyMap(), eq(630_000L));
    }

    @Test
    void marqueur_reserve_dans_le_code_soumis_rejete_sans_conteneur() {
        // __MOODIT_ dans la copie recevrait les substitutions runtime (jeton, canaris) : rejet
        // explicite AVANT tout conteneur — chaque cas échoue avec le même détail.
        // Poids absent sur un cas (champ optionnel de l'API) : le rejet passe par
        // effectiveWeight() — pas de NPE à l'unboxing.
        List<TestCaseInput> casesSansPoids = List.of(
                new TestCaseInput("premier", "h1", 2), new TestCaseInput("second", "h2", null));
        List<TestResult> results = evaluator.evaluate("Go",
                "package main\nfunc f() { println(\"[MOODIT] jeton=__MOODIT_T__\") }",
                casesSansPoids, null);
        assertThat(results).hasSize(2);
        assertThat(results).allSatisfy(r -> {
            assertThat(r.passed()).isFalse();
            assertThat(r.detail()).contains("Marqueur réservé");
        });
        org.mockito.Mockito.verifyNoInteractions(sandbox);
    }

    // ── Aiguillage selon la FORME du harnais (#116) ──────────────────────────────

    @Test
    void la_forme_du_harnais_choisit_le_chemin_dans_les_six_langages() {
        // Les deux formes sont notables : un corps qui renvoie un booléen passe par le modèle à
        // deux processus et deux UID (non falsifiable), un vrai test du framework par l'ancien
        // chemin. `frameworkMarkerFound` est le SEUL aiguillage — rien n'est refusé en amont.
        record Cas(String langage, String booleen, String framework) { }
        List<Cas> cas = List.of(
                new Cas("java", "return Solution.doubler(5) == 10;", "@Test void t() {}"),
                new Cas("csharp", "return Solution.Doubler(5) == 10;", "[Test] public void T() {}"),
                new Cas("go", "return doubler(5) == 10", "func TestT(t *testing.T) {}"),
                new Cas("rust", "doubler(5) == 10", "#[test] fn t() {}"),
                new Cas("c", "return doubler(5) == 10;", "MOODIT_TEST(t) { }"),
                new Cas("cpp", "return doubler(5) == 10;", "MOODIT_TEST(t) { }"));
        for (Cas c : cas) {
            assertThat(DockerEvaluator.frameworkMarkerFound(c.langage(), c.booleen()))
                    .as("harnais booléen en " + c.langage() + " → chemin non falsifiable")
                    .isFalse();
            assertThat(DockerEvaluator.frameworkMarkerFound(c.langage(), c.framework()))
                    .as("harnais framework en " + c.langage() + " → ancien chemin")
                    .isTrue();
        }
    }

    @Test
    void formes_parametrees_et_qualifiees_reconnues_comme_framework() {
        // Formes IDIOMATIQUES qu'un contrôle littéral prenait pour des harnais booléens.
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "[TestCase(3, 4, 12)] public void Aire(…) {}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "[ TestCaseSource(nameof(Cas)) ] void T() {}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("java",
                "@ParameterizedTest @ValueSource(ints = {1}) void t(int n) {}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("java",
                "@org.junit.jupiter.api.Test void t() {}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("java", "@RepeatedTest(3) void t() {}"))
                .isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("rust",
                "#[cfg(test)] mod m { #[test] fn t() {} }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("cpp", "MOODIT_TEST (aire) { }")).isTrue();
    }

    @Test
    void mur_plafonne_pour_un_appel_public() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // 10 cas × (60 s + 10 s + 90 s) dépasserait largement le plafond public (4 min).
        List<TestCaseInput> many = java.util.stream.IntStream.range(0, 10)
                .mapToObj(i -> new TestCaseInput("c" + i, "h", 1)).toList();
        evaluator.evaluate("Go", "code", many, 60_000, DockerEvaluator.PUBLIC_WALL_MS);
        verify(sandbox).run(eq("moodit-runner-go:latest"), anyMap(),
                eq(DockerEvaluator.PUBLIC_WALL_MS));
    }

    @Test
    void canaris_incoherents_neutralisent_les_verdicts_cote_java() {
        // Défense en PROFONDEUR : même si le superviseur renvoyait « passed », Java refuse.
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"passed":true,"detail":null},
                  {"index":1,"passed":true,"detail":null}
                ],"events":[],"canaries":"incoherents"}
                """);
        List<TestResult> results = evaluator.evaluate("C", "code", TWO_CASES, null);
        assertThat(results).allSatisfy(r -> {
            assertThat(r.passed()).isFalse();
            assertThat(r.detail()).contains("Incohérence détectée");
        });
    }
}
