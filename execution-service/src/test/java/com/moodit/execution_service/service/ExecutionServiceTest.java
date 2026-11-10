package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.sandbox.RunnerExec;
import com.moodit.execution_service.sandbox.DockerEvaluator;
import com.moodit.execution_service.sandbox.SandboxException;
import org.junit.jupiter.api.Test;
import org.mockito.stubbing.Answer;

import java.util.List;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Tests de la LOGIQUE DE VERDICT (Piston mocké, assembleur réel). Vérifie surtout l'ANTI-TRICHE :
 * un test ne réussit que si le harnais a émis le NONCE secret — pas parce que le programme s'est
 * terminé en exit 0 (falsifiable). Couvre aussi compilation, timeout et le verdict SQL par sortie.
 */
class ExecutionServiceTest {

    private final CodeAssembler assembler = new CodeAssembler("/nonexistent-vendor");
    private final RunnerExec runner = mock(RunnerExec.class);
    private final ExecutionService service = new ExecutionService(assembler, runner);

    private static final Pattern NONCE = Pattern.compile("MOODIT_OK_[0-9a-f]+");

    /** Retrouve le nonce injecté dans les fichiers assemblés (pour simuler un harnais qui réussit). */
    private static String nonceIn(List<RunnerExec.File> files) {
        for (RunnerExec.File f : files) {
            Matcher m = NONCE.matcher(f.content());
            if (m.find()) return m.group();
        }
        return "";
    }

    private EvaluateRequest oneTest(String language, String code, String harness) {
        return new EvaluateRequest(language, null, code, List.of(new TestCaseInput("t", harness, 1)));
    }

    /** Fait renvoyer à Piston une étape run(stdout, stderr) calculée à partir des fichiers soumis. */
    private void pistonRun(Function<List<RunnerExec.File>, RunnerExec.Stage> runFn) {
        when(runner.execute(anyString(), any(), any(), any())).thenAnswer((Answer<RunnerExec.Result>) inv -> {
            List<RunnerExec.File> files = inv.getArgument(1);
            return new RunnerExec.Result(null, runFn.apply(files), null);
        });
    }

    private boolean verdict(EvaluateRequest req) {
        List<TestResult> results = service.evaluate(req);
        assertThat(results).hasSize(1);
        return results.get(0).passed();
    }

    @Test
    void budget_depasse_les_harnais_restants_ne_sont_pas_lances() {
        // Le chemin interprété lance un conteneur et prend une place PAR HARNAIS (100 autorisés) :
        // sans échéance, une correction occupait le sandbox des heures après que l'appelant a
        // renoncé, et core devait budgéter un délai de lecture du même ordre (#216). Budget à 0 :
        // le PREMIER harnais part quand même (un budget mal réglé dégrade, il ne vide pas la
        // correction de tout verdict réel), les suivants reçoivent un verdict explicite.
        pistonRun(files -> new RunnerExec.Stage("", nonceIn(files), 0, null, null));
        service.interpretedBudgetMs = 0;

        List<TestResult> results = service.evaluate(new EvaluateRequest("Python", null,
                "def solution(): return 5",
                List.of(new TestCaseInput("a", "return True", 1),
                        new TestCaseInput("b", "return True", 2),
                        new TestCaseInput("c", "return True", 3))));

        assertThat(results).hasSize(3);
        // Le premier est réellement évalué…
        assertThat(results.get(0).name()).isEqualTo("a");
        assertThat(results.get(0).passed()).isTrue();
        // …les suivants ne sont pas lancés : verdict NON réussi, poids conservé (la note reste
        // calculable), détail explicite pour le prof.
        assertThat(results).extracting(TestResult::name).containsExactly("a", "b", "c");
        assertThat(results.get(1).passed()).isFalse();
        assertThat(results.get(1).weight()).isEqualTo(2);
        assertThat(results.get(1).detail()).contains("budget d'évaluation dépassé");
        assertThat(results.get(2).weight()).isEqualTo(3);
        assertThat(results.get(2).detail()).contains("budget d'évaluation dépassé");
        // Un SEUL passage au runner : c'est la garantie de capacité, pas seulement un libellé.
        verify(runner, times(1)).execute(anyString(), any(), any(), any());
    }

    @Test
    void budget_absurde_ne_degrade_pas_la_correction() {
        // Garde-fou de débordement : un budget délirant (mauvaise variable d'environnement)
        // saturait la conversion en nanosecondes, l'addition débordait en une échéance NÉGATIVE
        // — donc DÉJÀ dépassée — et un seul harnais sur cent était évalué. Une configuration
        // absurde doit être ramenée, jamais corrompre une note.
        pistonRun(files -> new RunnerExec.Stage("", nonceIn(files), 0, null, null));
        service.interpretedBudgetMs = Long.MAX_VALUE;

        List<TestResult> results = service.evaluate(new EvaluateRequest("Python", null,
                "def solution(): return 5",
                List.of(new TestCaseInput("a", "return True", 1),
                        new TestCaseInput("b", "return True", 1),
                        new TestCaseInput("c", "return True", 1))));

        assertThat(results).extracting(TestResult::passed).containsExactly(true, true, true);
        verify(runner, times(3)).execute(anyString(), any(), any(), any());
    }

    @Test
    void budget_large_tous_les_harnais_sont_evalues() {
        // Contrôle négatif du test ci-dessus : avec le budget par défaut (15 min), l'échéance
        // n'intervient jamais — sinon le test précédent passerait pour la mauvaise raison.
        pistonRun(files -> new RunnerExec.Stage("", nonceIn(files), 0, null, null));

        List<TestResult> results = service.evaluate(new EvaluateRequest("Python", null,
                "def solution(): return 5",
                List.of(new TestCaseInput("a", "return True", 1),
                        new TestCaseInput("b", "return True", 1),
                        new TestCaseInput("c", "return True", 1))));

        assertThat(results).extracting(TestResult::passed).containsExactly(true, true, true);
        verify(runner, times(3)).execute(anyString(), any(), any(), any());
    }

    @Test
    void passes_when_harness_emits_the_nonce() {
        // Harnais réussi = il a écrit le nonce sur stderr.
        pistonRun(files -> new RunnerExec.Stage("", nonceIn(files), 0, null, null));
        assertThat(verdict(oneTest("Python", "def solution(): return 5", "return True"))).isTrue();
    }

    @Test
    void fails_when_nonce_absent_even_though_exit_zero() {
        // ANTI-TRICHE : exit 0 mais AUCUN nonce (ex. sys.exit(0) anticipé) → échec.
        pistonRun(files -> new RunnerExec.Stage("", "", 0, null, null));
        assertThat(verdict(oneTest("Python", "import sys; sys.exit(0)", "return False"))).isFalse();
    }

    @Test
    void fails_when_harness_returns_false() {
        // Échec légitime : le programme s'est terminé sans émettre le nonce.
        pistonRun(files -> new RunnerExec.Stage("", "", 1, null, null));
        assertThat(verdict(oneTest("Python", "def solution(): return 5", "return solution() == 6"))).isFalse();
    }

    @Test
    void fails_on_compile_error() {
        // TypeScript : seul langage encore assemblé pour Piston avec une étape de compilation.
        when(runner.execute(anyString(), any(), any(), any())).thenReturn(new RunnerExec.Result(
                new RunnerExec.Stage("", "erreur de compilation", 1, null, null), null, null));
        List<TestResult> r = service.evaluate(
                oneTest("TypeScript", "function solution(): number { return 5; }", "return true;"));
        assertThat(r).singleElement().satisfies(t -> {
            assertThat(t.passed()).isFalse();
            assertThat(t.detail()).contains("erreur de compilation");
        });
    }

    @Test
    void fails_on_timeout_signal() {
        pistonRun(files -> new RunnerExec.Stage("", "", null, "SIGKILL", null));
        assertThat(verdict(oneTest("Python", "while True: pass", "return True"))).isFalse();
    }

    /** Sortie SQL = verdict encadré par les sentinelles au nonce (comme le produit main.sql). */
    private static String sqlFenced(List<RunnerExec.File> files, String verdictLine) {
        String nonce = nonceIn(files);
        return CodeAssembler.sqlVerdictStart(nonce) + "\n" + verdictLine + "\n"
                + CodeAssembler.sqlVerdictEnd(nonce) + "\n";
    }

    @Test
    void sql_passes_when_fenced_verdict_is_one() {
        pistonRun(files -> new RunnerExec.Stage(sqlFenced(files, "1"), "", 0, null, null));
        assertThat(verdict(oneTest("SQL", "SELECT nom FROM t", "SELECT 1;"))).isTrue();
    }

    @Test
    void sql_fails_when_fenced_verdict_is_zero() {
        pistonRun(files -> new RunnerExec.Stage(sqlFenced(files, "0"), "", 0, null, null));
        assertThat(verdict(oneTest("SQL", "SELECT nom FROM t", "SELECT 0;"))).isFalse();
    }

    @Test
    void sql_ignores_student_output_printed_before_the_fence() {
        // ANTI-FORGERIE : l'étudiant affiche « 1 » AVANT la sentinelle, mais le vrai verdict (entre
        // sentinelles) vaut « 0 » → échec. Sans encadrement, la ligne « 1 » aurait fait réussir.
        pistonRun(files -> new RunnerExec.Stage("1\n" + sqlFenced(files, "0"), "", 0, null, null));
        assertThat(verdict(oneTest("SQL", "SELECT 1", "SELECT 0;"))).isFalse();
    }

    @Test
    void sql_fails_when_the_fence_is_absent() {
        // Sentinelles avalées (ex. un /* étudiant) → verdict introuvable → échec.
        pistonRun(files -> new RunnerExec.Stage("1\n", "", 0, null, null));
        assertThat(verdict(oneTest("SQL", "SELECT 1", "SELECT 0;"))).isFalse();
    }

    // Harnais SQL en mode MODIFICATION (marqueur -- @student) → exécution ISOLÉE en 2 phases.
    private static final String SQL_MUTATION_HARNESS =
            "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(1);\n-- @student\nSELECT (SELECT n FROM t) = 0;";

    @Test
    void sql_mutation_runs_two_isolated_phases() {
        // Phase 1 (contient « .dump ») → renvoie un dump encadré ; phase 2 → verdict encadré « 1 ».
        pistonRun(files -> {
            String nonce = nonceIn(files);
            if (files.get(0).content().contains(".dump")) {
                String dump = CodeAssembler.sqlDumpStart(nonce) + "\n"
                        + "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(0);\n"
                        + CodeAssembler.sqlDumpEnd(nonce) + "\n";
                return new RunnerExec.Stage(dump, "", 0, null, null);
            }
            return new RunnerExec.Stage(sqlFenced(files, "1"), "", 0, null, null);
        });
        assertThat(verdict(oneTest("SQL", "UPDATE t SET n = 0", SQL_MUTATION_HARNESS))).isTrue();
    }

    @Test
    void sql_mutation_phase2_never_receives_student_code() {
        // Le code étudiant ne doit JAMAIS apparaître dans le fichier de la phase 2 (le noteur).
        pistonRun(files -> {
            String nonce = nonceIn(files);
            if (files.get(0).content().contains(".dump")) {
                assertThat(files.get(0).content()).contains("UPDATE t SET n = 0"); // phase 1 : oui
                return new RunnerExec.Stage(CodeAssembler.sqlDumpStart(nonce) + "\n"
                        + "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(0);\n"
                        + CodeAssembler.sqlDumpEnd(nonce) + "\n", "", 0, null, null);
            }
            assertThat(files.get(0).content()).doesNotContain("UPDATE t SET n = 0"); // phase 2 : jamais
            return new RunnerExec.Stage(sqlFenced(files, "1"), "", 0, null, null);
        });
        assertThat(verdict(oneTest("SQL", "UPDATE t SET n = 0", SQL_MUTATION_HARNESS))).isTrue();
    }

    @Test
    void sql_mutation_fails_when_student_phase_errors() {
        // Erreur SQL de l'étudiant en phase 1 (exit != 0) → test échoué, sans lancer la phase 2.
        pistonRun(files -> new RunnerExec.Stage("", "near \"x\": syntax error", 1, null, null));
        assertThat(verdict(oneTest("SQL", "x", SQL_MUTATION_HARNESS))).isFalse();
    }

    @Test
    void sql_student_code_cannot_trigger_two_phase_via_marker() {
        // SÉCURITÉ : « -- @student » dans le CODE de l'étudiant n'active PAS le mode 2 phases — le
        // routage ne regarde QUE le harnais. Harnais SANS marqueur → lecture seule = UN seul appel
        // Piston (un mode 2 phases en ferait deux). On compte les appels pour le prouver.
        final int[] calls = { 0 };
        pistonRun(files -> { calls[0]++; return new RunnerExec.Stage(sqlFenced(files, "1"), "", 0, null, null); });
        assertThat(verdict(oneTest("SQL", "SELECT 1 -- @student", "SELECT (SELECT count(*) FROM solution1) >= 0;"))).isTrue();
        assertThat(calls[0]).isEqualTo(1);
    }

    @Test
    void weights_are_reported_per_test() {
        pistonRun(files -> new RunnerExec.Stage("", nonceIn(files), 0, null, null));
        EvaluateRequest req = new EvaluateRequest("Python", null, "def solution(): return 5",
                List.of(new TestCaseInput("a", "return True", 3)));
        assertThat(service.evaluate(req)).singleElement()
                .satisfies(t -> assertThat(t.weight()).isEqualTo(3));
    }

    @Test
    void chaque_appel_piston_occupe_une_place_du_sandbox() {
        // Limite globale d'UNE place, déjà occupée par l'appelant : tout appel Piston (run, harnais,
        // SQL en deux phases) doit passer par cette place, donc être refusé sans appeler Piston.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 0, 1);
        ExecutionService limited = new ExecutionService(assembler, runner, limiter, null);
        pistonRun(files -> new RunnerExec.Stage("", nonceIn(files), 0, null, null));

        limiter.withSandboxSlot(() -> {
            assertThatThrownBy(() -> limited.run(new RunRequest("Python", null, "print(1)")))
                    .isInstanceOf(ExecutionBusyException.class);
            assertThatThrownBy(() -> limited.evaluate(oneTest("Python", "def f(): pass", "return True")))
                    .isInstanceOf(ExecutionBusyException.class);
            assertThatThrownBy(() -> limited.evaluate(oneTest("SQL", "UPDATE t SET n = 0", SQL_MUTATION_HARNESS)))
                    .isInstanceOf(ExecutionBusyException.class);
            return null;
        });
        verify(runner, never()).execute(anyString(), any(), any(), any());

        // Place rendue : la même exécution passe.
        assertThat(limited.evaluate(oneTest("Python", "def f(): pass", "return True")))
                .singleElement().satisfies(t -> assertThat(t.passed()).isTrue());
    }

    // ── Routage des langages COMPILÉS vers le runner Docker (#116) ────────────────

    /** Marqueur de « vrai test du framework » attendu par langage (cf. legacyHarnessRejection). */
    private static String frameworkHarness(String language) {
        return switch (language) {
            case "Java" -> "@Test void t() {}";
            case "C#" -> "[Test] public void T() {}";
            case "Go" -> "func TestT(t *testing.T) {}";
            case "Rust" -> "#[test] fn t() {}";
            default -> "MOODIT_TEST(t) { }";          // C / C++
        };
    }

    @Test
    void compiled_languages_route_to_docker_evaluator_not_piston() {
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionService routed = new ExecutionService(assembler, runner, docker);
        List<TestResult> expected = List.of(new TestResult("t", 1, true, null));
        when(docker.evaluate(anyString(), anyString(), any(), any(), anyLong())).thenReturn(expected);

        for (String language : List.of("Java", "C#", "Go", "Rust", "C", "C++")) {
            assertThat(routed.evaluate(oneTest(language, "code", frameworkHarness(language))))
                    .isEqualTo(expected);
        }
        verify(docker, times(6)).evaluate(anyString(), anyString(), any(), any(), anyLong());
        verify(runner, never()).execute(anyString(), any(), any(), any());
    }

    @Test
    void compiled_evaluation_fails_cleanly_without_docker_runner() {
        // Service construit sans runner (ex. mauvaise config) : erreur 502 propre, pas de NPE.
        assertThatThrownBy(() -> service.evaluate(oneTest("Java", "class A {}", "harnais")))
                .isInstanceOf(SandboxException.class);
    }

    @Test
    void compiled_evaluation_takes_a_sandbox_slot() {
        // Un conteneur runner consomme une place de la limite globale, comme un appel Piston.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 0, 1);
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionService limited = new ExecutionService(assembler, runner, limiter, docker);
        limiter.withSandboxSlot(() -> {
            assertThatThrownBy(() -> limited.evaluate(
                    oneTest("Go", "code", frameworkHarness("Go"))))
                    .isInstanceOf(ExecutionBusyException.class);
            return null;
        });
        verify(docker, never()).evaluate(anyString(), anyString(), any(), any(), anyLong());
    }

    @Test
    void timeout_is_forwarded_to_the_runner_for_interpreted_and_sql() {
        // Un retour silencieux au défaut (3 s) passerait avec any() : on épingle eq(42_000)
        // sur le chemin interprété ET sur le chemin SQL (chaque phase a son conteneur).
        pistonRun(files -> new RunnerExec.Stage("", nonceIn(files), 0, null, null));
        service.evaluate(new EvaluateRequest("Python", null, "def solution(): return 5",
                List.of(new TestCaseInput("t", "return True", 1)), 42_000));
        verify(runner).execute(eq("python"), any(), any(), eq(42_000));

        service.evaluate(new EvaluateRequest("SQL", null, "SELECT 1;",
                List.of(new TestCaseInput("t", "SELECT 1;", 1)), 42_000));
        verify(runner, org.mockito.Mockito.atLeastOnce())
                .execute(eq("sqlite3"), any(), any(), eq(42_000));
    }

    @Test
    void timeout_is_forwarded_to_docker_evaluator() {
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionService routed = new ExecutionService(assembler, runner, docker);
        when(docker.evaluate(anyString(), anyString(), any(), any(), anyLong())).thenReturn(List.of());
        routed.evaluate(new EvaluateRequest("Rust", null, "code",
                List.of(new TestCaseInput("t", frameworkHarness("Rust"), 1)), 42_000));
        verify(docker).evaluate(eq("Rust"), eq("code"), any(), eq(42_000), anyLong());
    }

    @Test
    void rejets_avant_la_prise_de_place_et_mur_plafonne_selon_l_appelant() {
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionLimiter limiter = new ExecutionLimiter(2, 0, 5);
        ExecutionService routed = new ExecutionService(assembler, runner, limiter, docker);

        // 1. Marqueur réservé dans le code : verdict explicite, aucun conteneur.
        List<TestResult> marker = routed.evaluate(
                oneTest("Go", "jeton=__MOODIT_T__", frameworkHarness("Go")));
        assertThat(marker.get(0).passed()).isFalse();
        assertThat(marker.get(0).detail()).contains("Marqueur réservé");

        // 2. Harnais resté à l'ancien format : diagnostic explicite, aucun conteneur.
        List<TestResult> legacy = routed.evaluate(oneTest("Go", "code", "return vrai;"));
        assertThat(legacy.get(0).detail()).contains("ancien format");
        verifyNoInteractions(docker);

        // 3. Appel PUBLIC : le mur est plafonné ; appel INTERNE : budget complet.
        when(docker.evaluate(anyString(), anyString(), any(), any(), anyLong()))
                .thenReturn(List.of());
        routed.evaluate(oneTest("Go", "code", frameworkHarness("Go")));
        verify(docker).evaluate(anyString(), anyString(), any(), any(),
                eq(DockerEvaluator.PUBLIC_WALL_MS));

        limiter.asInternal(() -> routed.evaluate(oneTest("Go", "code", frameworkHarness("Go"))));
        verify(docker).evaluate(anyString(), anyString(), any(), any(), eq(Long.MAX_VALUE));
    }
}
