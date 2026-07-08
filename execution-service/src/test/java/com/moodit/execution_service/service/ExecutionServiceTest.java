package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonClient;
import org.junit.jupiter.api.Test;
import org.mockito.stubbing.Answer;

import java.util.List;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Tests de la LOGIQUE DE VERDICT (Piston mocké, assembleur réel). Vérifie surtout l'ANTI-TRICHE :
 * un test ne réussit que si le harnais a émis le NONCE secret — pas parce que le programme s'est
 * terminé en exit 0 (falsifiable). Couvre aussi compilation, timeout et le verdict SQL par sortie.
 */
class ExecutionServiceTest {

    private final CodeAssembler assembler = new CodeAssembler("/nonexistent-vendor");
    private final PistonClient piston = mock(PistonClient.class);
    private final ExecutionService service = new ExecutionService(assembler, piston);

    private static final Pattern NONCE = Pattern.compile("MOODIT_OK_[0-9a-f]+");

    /** Retrouve le nonce injecté dans les fichiers assemblés (pour simuler un harnais qui réussit). */
    private static String nonceIn(List<PistonClient.File> files) {
        for (PistonClient.File f : files) {
            Matcher m = NONCE.matcher(f.content());
            if (m.find()) return m.group();
        }
        return "";
    }

    private EvaluateRequest oneTest(String language, String code, String harness) {
        return new EvaluateRequest(language, null, code, List.of(new TestCaseInput("t", harness, 1)));
    }

    /** Fait renvoyer à Piston une étape run(stdout, stderr) calculée à partir des fichiers soumis. */
    private void pistonRun(Function<List<PistonClient.File>, PistonClient.Stage> runFn) {
        when(piston.execute(anyString(), any(), any())).thenAnswer((Answer<PistonClient.Result>) inv -> {
            List<PistonClient.File> files = inv.getArgument(2);
            return new PistonClient.Result(null, runFn.apply(files), null);
        });
    }

    private boolean verdict(EvaluateRequest req) {
        List<TestResult> results = service.evaluate(req);
        assertThat(results).hasSize(1);
        return results.get(0).passed();
    }

    @Test
    void passes_when_harness_emits_the_nonce() {
        // Harnais réussi = il a écrit le nonce sur stderr.
        pistonRun(files -> new PistonClient.Stage("", nonceIn(files), 0, null, null));
        assertThat(verdict(oneTest("Python", "def solution(): return 5", "return True"))).isTrue();
    }

    @Test
    void fails_when_nonce_absent_even_though_exit_zero() {
        // ANTI-TRICHE : exit 0 mais AUCUN nonce (ex. sys.exit(0) anticipé) → échec.
        pistonRun(files -> new PistonClient.Stage("", "", 0, null, null));
        assertThat(verdict(oneTest("Python", "import sys; sys.exit(0)", "return False"))).isFalse();
    }

    @Test
    void fails_when_harness_returns_false() {
        // Échec légitime : le programme s'est terminé sans émettre le nonce.
        pistonRun(files -> new PistonClient.Stage("", "", 1, null, null));
        assertThat(verdict(oneTest("Python", "def solution(): return 5", "return solution() == 6"))).isFalse();
    }

    @Test
    void fails_on_compile_error() {
        when(piston.execute(anyString(), any(), any())).thenReturn(new PistonClient.Result(
                new PistonClient.Stage("", "erreur de compilation", 1, null, null), null, null));
        List<TestResult> r = service.evaluate(oneTest("C", "int solution(){return 5;}", "return 1;"));
        assertThat(r).singleElement().satisfies(t -> {
            assertThat(t.passed()).isFalse();
            assertThat(t.detail()).contains("erreur de compilation");
        });
    }

    @Test
    void fails_on_timeout_signal() {
        pistonRun(files -> new PistonClient.Stage("", "", null, "SIGKILL", null));
        assertThat(verdict(oneTest("Python", "while True: pass", "return True"))).isFalse();
    }

    /** Sortie SQL = verdict encadré par les sentinelles au nonce (comme le produit main.sql). */
    private static String sqlFenced(List<PistonClient.File> files, String verdictLine) {
        String nonce = nonceIn(files);
        return CodeAssembler.sqlVerdictStart(nonce) + "\n" + verdictLine + "\n"
                + CodeAssembler.sqlVerdictEnd(nonce) + "\n";
    }

    @Test
    void sql_passes_when_fenced_verdict_is_one() {
        pistonRun(files -> new PistonClient.Stage(sqlFenced(files, "1"), "", 0, null, null));
        assertThat(verdict(oneTest("SQL", "SELECT nom FROM t", "SELECT 1;"))).isTrue();
    }

    @Test
    void sql_fails_when_fenced_verdict_is_zero() {
        pistonRun(files -> new PistonClient.Stage(sqlFenced(files, "0"), "", 0, null, null));
        assertThat(verdict(oneTest("SQL", "SELECT nom FROM t", "SELECT 0;"))).isFalse();
    }

    @Test
    void sql_ignores_student_output_printed_before_the_fence() {
        // ANTI-FORGERIE : l'étudiant affiche « 1 » AVANT la sentinelle, mais le vrai verdict (entre
        // sentinelles) vaut « 0 » → échec. Sans encadrement, la ligne « 1 » aurait fait réussir.
        pistonRun(files -> new PistonClient.Stage("1\n" + sqlFenced(files, "0"), "", 0, null, null));
        assertThat(verdict(oneTest("SQL", "SELECT 1", "SELECT 0;"))).isFalse();
    }

    @Test
    void sql_fails_when_the_fence_is_absent() {
        // Sentinelles avalées (ex. un /* étudiant) → verdict introuvable → échec.
        pistonRun(files -> new PistonClient.Stage("1\n", "", 0, null, null));
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
                return new PistonClient.Stage(dump, "", 0, null, null);
            }
            return new PistonClient.Stage(sqlFenced(files, "1"), "", 0, null, null);
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
                return new PistonClient.Stage(CodeAssembler.sqlDumpStart(nonce) + "\n"
                        + "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(0);\n"
                        + CodeAssembler.sqlDumpEnd(nonce) + "\n", "", 0, null, null);
            }
            assertThat(files.get(0).content()).doesNotContain("UPDATE t SET n = 0"); // phase 2 : jamais
            return new PistonClient.Stage(sqlFenced(files, "1"), "", 0, null, null);
        });
        assertThat(verdict(oneTest("SQL", "UPDATE t SET n = 0", SQL_MUTATION_HARNESS))).isTrue();
    }

    @Test
    void sql_mutation_fails_when_student_phase_errors() {
        // Erreur SQL de l'étudiant en phase 1 (exit != 0) → test échoué, sans lancer la phase 2.
        pistonRun(files -> new PistonClient.Stage("", "near \"x\": syntax error", 1, null, null));
        assertThat(verdict(oneTest("SQL", "x", SQL_MUTATION_HARNESS))).isFalse();
    }

    @Test
    void sql_student_code_cannot_trigger_two_phase_via_marker() {
        // SÉCURITÉ : « -- @student » dans le CODE de l'étudiant n'active PAS le mode 2 phases — le
        // routage ne regarde QUE le harnais. Harnais SANS marqueur → lecture seule = UN seul appel
        // Piston (un mode 2 phases en ferait deux). On compte les appels pour le prouver.
        final int[] calls = { 0 };
        pistonRun(files -> { calls[0]++; return new PistonClient.Stage(sqlFenced(files, "1"), "", 0, null, null); });
        assertThat(verdict(oneTest("SQL", "SELECT 1 -- @student", "SELECT (SELECT count(*) FROM solution1) >= 0;"))).isTrue();
        assertThat(calls[0]).isEqualTo(1);
    }

    @Test
    void weights_are_reported_per_test() {
        pistonRun(files -> new PistonClient.Stage("", nonceIn(files), 0, null, null));
        EvaluateRequest req = new EvaluateRequest("Python", null, "def solution(): return 5",
                List.of(new TestCaseInput("a", "return True", 3)));
        assertThat(service.evaluate(req)).singleElement()
                .satisfies(t -> assertThat(t.weight()).isEqualTo(3));
    }
}
