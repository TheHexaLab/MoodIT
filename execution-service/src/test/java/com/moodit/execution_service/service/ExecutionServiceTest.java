package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.sandbox.RunnerExec;
import com.moodit.execution_service.sandbox.DockerEvaluator;
import com.moodit.execution_service.sandbox.HarnessProjects;
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
    void budget_exceeded_remaining_harnesses_not_launched() {
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
    void budget_exhausted_by_internal_slot_wait_is_a_failure_not_a_grade()
            throws Exception {
        // VRAIE charge : la place unique du sandbox est occupee par une autre correction pendant
        // 600 ms. L'evaluation attend, et c'est cette attente — creee par les autres — qui epuise
        // le budget de 200 ms ; le travail lui-meme (harnais instantanes) tenait dedans. Sur le
        // chemin interne, ce n'est pas une note : 502, la tentative est a reprendre.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 5000, 5000, 1);
        ExecutionService svc = new ExecutionService(assembler, runner, limiter, null);
        svc.interpretedBudgetMs = 200;
        pistonRun(files -> new RunnerExec.Stage("", nonceIn(files), 0, null, null));
        java.util.concurrent.CountDownLatch acquired = new java.util.concurrent.CountDownLatch(1);
        Thread other = new Thread(() -> limiter.asInternal(() -> limiter.withSandboxSlot(() -> {
            acquired.countDown();
            try {
                Thread.sleep(600);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
            return null;
        })));
        other.start();
        acquired.await();
        EvaluateRequest req = new EvaluateRequest("Python", null, "def solution(): return 5",
                List.of(new TestCaseInput("a", "return True", 1),
                        new TestCaseInput("b", "return True", 2)));

        // Compté par core (S4, F4) : sinon un code qui s'arrête juste sous le temps limite
        // laissait la file transformer chaque essai en suppression non comptée.
        assertThatThrownBy(() -> limiter.asInternal(() -> svc.evaluate(req)))
                .isInstanceOf(com.moodit.execution_service.sandbox.NoVerdictException.class);
        other.join();
    }

    @Test
    void slow_solution_within_delay_without_wait_gets_partial_grade() {
        // Le scenario de la revue : une solution CORRECTE mais lente, chaque harnais sous son
        // delai, aucune attente de place. Le budget s'epuise de facon REPRODUCTIBLE — en faire un
        // 502 rendait la question impossible a noter (502 a chaque renvoi) et bloquait une place a
        // chaque essai. C'est une note PARTIELLE, comme avant.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 5000, 5000, 1);
        ExecutionService svc = new ExecutionService(assembler, runner, limiter, null);
        svc.interpretedBudgetMs = 200;
        pistonRun(files -> {
            try {
                Thread.sleep(400);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
            return new RunnerExec.Stage("", nonceIn(files), 0, null, null);
        });
        EvaluateRequest req = new EvaluateRequest("Python", null, "def solution(): return 5",
                List.of(new TestCaseInput("a", "return True", 1),
                        new TestCaseInput("b", "return True", 2)));

        List<TestResult> r = limiter.asInternal(() -> svc.evaluate(req));
        assertThat(r).hasSize(2);
        assertThat(r.get(0).passed()).isTrue();
        assertThat(r.get(1).passed()).isFalse();
        assertThat(r.get(1).detail()).contains("budget d'évaluation dépassé");
    }

    /** Occupe la place UNIQUE du sandbox pendant {@code holdMs}, puis rend la main. */
    private static Thread holdSlot(ExecutionLimiter limiter, long holdMs) throws InterruptedException {
        java.util.concurrent.CountDownLatch acquired = new java.util.concurrent.CountDownLatch(1);
        Thread other = new Thread(() -> limiter.asInternal(() -> limiter.withSandboxSlot(() -> {
            acquired.countDown();
            sleep(holdMs);
            return null;
        })));
        other.start();
        acquired.await();
        return other;
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
    }

    private static EvaluateRequest twoPythonCases() {
        return new EvaluateRequest("Python", null, "def solution(): return 5",
                List.of(new TestCaseInput("a", "return True", 1),
                        new TestCaseInput("b", "return True", 2)));
    }

    @Test
    void budget_exhausted_by_interrupted_harness_stays_a_grade() throws Exception {
        // VRAIE contention (place occupee 500 ms par une autre correction, budget 1000 ms) ET un
        // harnais qui boucle jusqu'a son delai (800 ms, puis tue). Le travail mesure tient dans le
        // budget, mais l'etudiant a consomme PLUS que l'attente : c'est sa boucle, pas la charge,
        // qui a fait deborder. Sans ce garde-fou, une solution qui boucle dans une file chargee
        // partait en 502 — un essai de plus. Avec, c'est une note.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 5000, 5000, 1);
        ExecutionService svc = new ExecutionService(assembler, runner, limiter, null);
        svc.interpretedBudgetMs = 1000;
        pistonRun(files -> {
            sleep(800);
            return new RunnerExec.Stage("", "", null, "SIGKILL", null);
        });
        Thread other = holdSlot(limiter, 500);

        List<TestResult> r = limiter.asInternal(() -> svc.evaluate(twoPythonCases()));
        other.join();
        assertThat(r).hasSize(2);
        assertThat(r.get(0).detail()).startsWith("Interrompu");
        assertThat(r.get(1).passed()).isFalse();
        assertThat(r.get(1).detail()).contains("budget d'évaluation dépassé");
    }

    @Test
    void wait_dominating_a_short_interruption_is_still_load() throws Exception {
        // Un seul harnais interrompu tot (150 ms) ne met pas toute l'attente (900 ms) sur le
        // compte de l'etudiant : c'est la file qui a fait deborder le budget. Avant, la moindre
        // interruption suffisait a enregistrer des harnais « Non evalue » a 0 — sur une
        // tentative unique, pendant un examen charge.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 5000, 5000, 1);
        ExecutionService svc = new ExecutionService(assembler, runner, limiter, null);
        svc.interpretedBudgetMs = 800;
        pistonRun(files -> {
            sleep(150);
            return new RunnerExec.Stage("", "", null, "SIGKILL", null);
        });
        Thread other = holdSlot(limiter, 900);

        assertThatThrownBy(() -> limiter.asInternal(() -> svc.evaluate(twoPythonCases())))
                .isInstanceOf(com.moodit.execution_service.sandbox.NoVerdictException.class)
                .hasMessageContaining("charge du serveur");
        other.join();
    }

    @Test
    void student_output_imitating_an_interruption_does_not_count() throws Exception {
        // L'interruption se lit sur le SIGNAL de l'execution, plus sur le texte du detail : un
        // stderr etudiant qui commence par « Interrompu » ne change pas la regle.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 5000, 5000, 1);
        ExecutionService svc = new ExecutionService(assembler, runner, limiter, null);
        svc.interpretedBudgetMs = 200;
        pistonRun(files -> new RunnerExec.Stage("", "Interrompu (signal SIGKILL)", 1, null, null));
        Thread other = holdSlot(limiter, 600);

        assertThatThrownBy(() -> limiter.asInternal(() -> svc.evaluate(twoPythonCases())))
                .isInstanceOf(com.moodit.execution_service.sandbox.NoVerdictException.class);
        other.join();
    }

    @Test
    void absurd_budget_does_not_degrade_grading() {
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
    void ample_budget_evaluates_every_harness() {
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

    /** Harnais BOOLÉEN par langage : la forme des gabarits, notée sans falsification possible. */
    private static String booleanHarness(String language) {
        return switch (language) {
            case "Rust" -> "doubler(5) == 10";
            case "Go" -> "return doubler(5) == 10";
            default -> "return doubler(5) == 10;";    // Java, C#, C, C++
        };
    }

    @Test
    void reserved_java_class_name_rejected_with_diagnostic() {
        // `public class harnais_rpc` portait la même clé de fichier que le harnais du prof (le
        // code soumis était écrasé) et `MooditX` est sauté à la copie par le superviseur : dans
        // les deux cas, « Aucun fichier de code soumis » — un 0 qui n'explique pas la cause.
        // Refus AVANT toute prise de place, avec le nom fautif dans le diagnostic.
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionService routed = new ExecutionService(assembler, runner, docker);

        for (String className : List.of("MooditPiege", "harnais_rpc")) {
            List<TestResult> results = routed.evaluate(oneTest("Java",
                    "public class " + className + " { static int f() { return 1; } }",
                    "return " + className + ".f() == 1;"));
            assertThat(results).as("refus de " + className).hasSize(1);
            assertThat(results.get(0).passed()).isFalse();
            assertThat(results.get(0).detail()).contains(className).contains("réservé");
        }
        verifyNoInteractions(docker);
        // Et un nom NORMAL ne déclenche rien : le refus est chirurgical.
        assertThat(DockerEvaluator.reservedNameRejection("Java",
                "public class Solution { }", List.of())).isNull();
    }

    @Test
    void overlong_java_class_name_rejected_with_diagnostic() {
        // Le nom de la classe devient un nom de fichier : au-delà de la limite de Linux, le dépôt
        // dans le conteneur échouait — 502, tentative supprimée — au lieu d'une note.
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionService routed = new ExecutionService(assembler, runner, docker);
        String longName = "A".repeat(HarnessProjects.MAX_JAVA_TYPE_NAME_BYTES + 1);

        List<TestResult> results = routed.evaluate(oneTest("Java",
                "public class " + longName + " { static int f() { return 1; } }",
                "return " + longName + ".f() == 1;"));

        assertThat(results).hasSize(1);
        assertThat(results.get(0).passed()).isFalse();
        assertThat(results.get(0).detail()).contains("trop long").doesNotContain(longName);
        verifyNoInteractions(docker);
        // À la limite exacte, le nom passe.
        assertThat(DockerEvaluator.reservedNameRejection("Java",
                "public class " + "A".repeat(HarnessProjects.MAX_JAVA_TYPE_NAME_BYTES) + " { }",
                List.of())).isNull();
    }

    @Test
    void java_class_name_with_control_character_rejected_with_diagnostic() {
        // Java admet U+0000 (et les autres caractères « ignorables ») dans un identifiant, mais
        // le nom devient un nom de fichier : l'archive du dépôt était refusée par le démon (502,
        // tentative supprimée) ou le nom tronqué au NUL — jamais une note expliquée.
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionService routed = new ExecutionService(assembler, runner, docker);
        char nul = (char) 0;
        char zeroWidthSpace = (char) 0x200B;
        for (String className : List.of("A" + nul + "B", "S" + "a".repeat(90) + nul + "b",
                "A" + zeroWidthSpace + "B")) {
            List<TestResult> results = routed.evaluate(oneTest("Java",
                    "public class " + className + " { static int f() { return 1; } }",
                    "return true;"));
            assertThat(results).hasSize(1);
            assertThat(results.get(0).passed()).isFalse();
            assertThat(results.get(0).detail()).contains("caractère de contrôle ou invisible")
                    .doesNotContain(String.valueOf(nul));
        }
        verifyNoInteractions(docker);
    }

    @Test
    void framework_format_harness_rejected_with_diagnostic() {
        // Cette forme compilait le harnais AVEC le code de l'étudiant : le processus qui détenait
        // le secret était celui qu'il contrôle, et cinq canaux de forge y ont été démontrés. Elle
        // n'a jamais été déployée, donc rien n'en dépend — mais la laisser vivre offrait au prof
        // un chemin contournable sans qu'il le sache. Refus AVANT toute prise de place, avec la
        // forme à écrire à la place.
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionService routed = new ExecutionService(assembler, runner, docker);

        for (String language : List.of("Java", "C#", "Go", "Rust", "C", "C++")) {
            List<TestResult> results = routed.evaluate(
                    oneTest(language, "code", frameworkHarness(language)));
            assertThat(results).as("refus en " + language).hasSize(1);
            assertThat(results.get(0).passed()).isFalse();
            assertThat(results.get(0).detail())
                    .contains("classe de test du framework")
                    .contains("renvoie un booléen");
        }
        verifyNoInteractions(docker);
    }

    @Test
    void boolean_harness_reaches_runner_in_all_six_languages() {
        // RÉGRESSION : un garde-fou en amont renvoyait 0 à tous les cas d'une question dont le
        // harnais était justement au format SÛR, sans jamais atteindre le runner. Ce test entre
        // par la porte de PRODUCTION (ExecutionService.evaluate), pas par DockerEvaluator.
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionService routed = new ExecutionService(assembler, runner, docker);
        List<TestResult> expected = List.of(new TestResult("t", 1, true, null));
        when(docker.evaluate(anyString(), anyString(), any(), any(), anyLong())).thenReturn(expected);

        for (String language : List.of("Java", "C#", "Go", "Rust", "C", "C++")) {
            assertThat(routed.evaluate(oneTest(language, "code", booleanHarness(language))))
                    .as("harnais booléen en " + language)
                    .isEqualTo(expected);
        }
        verify(docker, times(6)).evaluate(anyString(), anyString(), any(), any(), anyLong());
    }

    /**
     * Harnais au format « vraie classe de test du framework », par langage.
     *
     * <p>Cette forme n'est plus notée : elle était compilée AVEC le code de l'étudiant, donc
     * falsifiable. Elle ne sert plus qu'à vérifier le REFUS.
     */
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
            assertThat(routed.evaluate(oneTest(language, "code", booleanHarness(language))))
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
                    oneTest("Go", "code", booleanHarness("Go"))))
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
                List.of(new TestCaseInput("t", booleanHarness("Rust"), 1)), 42_000));
        verify(docker).evaluate(eq("Rust"), eq("code"), any(), eq(42_000), anyLong());
    }

    @Test
    void rejections_before_slot_and_wall_capped_by_caller() {
        DockerEvaluator docker = mock(DockerEvaluator.class);
        ExecutionLimiter limiter = new ExecutionLimiter(2, 0, 5);
        ExecutionService routed = new ExecutionService(assembler, runner, limiter, docker);

        // 1. Marqueur réservé dans le code : verdict explicite, aucun conteneur.
        List<TestResult> marker = routed.evaluate(
                oneTest("Go", "jeton=__MOODIT_T__", booleanHarness("Go")));
        assertThat(marker.get(0).passed()).isFalse();
        assertThat(marker.get(0).detail()).contains("Marqueur réservé");

        // Le marqueur réservé est le SEUL refus en amont : un harnais booléen n'en est plus un,
        // c'est le format sûr, et il doit atteindre le runner (cf.
        // harnais_booleen_atteint_le_runner_dans_les_six_langages).
        verifyNoInteractions(docker);

        // 2. Appel PUBLIC : le mur est plafonné ; appel INTERNE : budget complet.
        when(docker.evaluate(anyString(), anyString(), any(), any(), anyLong()))
                .thenReturn(List.of());
        routed.evaluate(oneTest("Go", "code", booleanHarness("Go")));
        verify(docker).evaluate(anyString(), anyString(), any(), any(),
                eq(DockerEvaluator.PUBLIC_WALL_MS));

        limiter.asInternal(() -> routed.evaluate(oneTest("Go", "code", booleanHarness("Go"))));
        verify(docker).evaluate(anyString(), anyString(), any(), any(), eq(Long.MAX_VALUE));
    }
}
