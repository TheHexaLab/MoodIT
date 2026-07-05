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

    @Test
    void sql_passes_when_last_output_line_is_one() {
        when(piston.execute(anyString(), any(), any())).thenReturn(new PistonClient.Result(
                null, new PistonClient.Stage("1\n", "", 0, null, null), null));
        assertThat(verdict(oneTest("SQL", "SELECT nom FROM t", "SELECT 1;"))).isTrue();
    }

    @Test
    void sql_fails_when_last_output_line_is_zero() {
        when(piston.execute(anyString(), any(), any())).thenReturn(new PistonClient.Result(
                null, new PistonClient.Stage("0\n", "", 0, null, null), null));
        assertThat(verdict(oneTest("SQL", "SELECT nom FROM t", "SELECT 0;"))).isFalse();
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
