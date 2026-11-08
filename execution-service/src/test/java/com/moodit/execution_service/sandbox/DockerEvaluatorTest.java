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
        evaluator.evaluate("C++", "code", List.of(new TestCaseInput("t", "h", 1)), 5000);
        // 30 s de base + (1 cas + 2 canaris) × (5 s + 10 s de marge + 90 s de compilation PAR
        // CAS — chaque cas recompile son harnais) = 345 s.
        verify(sandbox).run(eq("moodit-runner-c:latest"), anyMap(), eq(345_000L));
    }

    @Test
    void temps_limite_aberrant_borne_jamais_de_mur_negatif() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // Négatif (valeur stockée aberrante) : borné à 1 ms, puis PLANCHER VM (10 s — miroir
        // du superviseur, JVM froide) — le mur reste positif et couvre le temps réel accordé.
        evaluator.evaluate("Java", "code", List.of(new TestCaseInput("t", "h", 1)), -100_000);
        verify(sandbox).run(eq("moodit-runner-java:latest"), anyMap(), eq(360_000L));

        // Au-delà du plafond de l'éditeur (60 s) : ramené à 60 s par cas.
        evaluator.evaluate("Go", "code", List.of(new TestCaseInput("t", "h", 1)), 999_999);
        verify(sandbox).run(eq("moodit-runner-go:latest"), anyMap(), eq(510_000L));
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
}
