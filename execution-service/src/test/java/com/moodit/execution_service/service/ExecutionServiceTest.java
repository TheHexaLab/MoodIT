package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.StructuredCase;
import com.moodit.execution_service.dto.StructuredEvaluateRequest;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonClient;
import org.junit.jupiter.api.Test;
import org.mockito.stubbing.Answer;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
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
    private static final ObjectMapper M = new ObjectMapper();

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
        when(piston.execute(anyString(), any(), any(), any())).thenAnswer((Answer<PistonClient.Result>) inv -> {
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
        when(piston.execute(anyString(), any(), any(), any())).thenReturn(new PistonClient.Result(
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

    // ───────────────── Cas STRUCTURÉS : modes de comparaison (verdict HORS sandbox) ─────────────────
    // Le serveur (mocké) émet « 1\n<valeur>\n » ; seul le mode de comparaison varie. Le code et
    // l'expression sont indifférents (Piston mocké) : on teste uniquement la décision de `jsonMatches`.

    private boolean structured(String emitted, String expectedJson, String compare) {
        pistonRun(files -> new PistonClient.Stage("1\n" + emitted + "\n", "", 0, null, null));
        StructuredEvaluateRequest req = new StructuredEvaluateRequest("go", null,
                "package main\nfunc doubler(n int) int { return n * 2 }",
                List.of(new StructuredCase("t", "return doubler(5)", M.readTree(expectedJson), compare, 1)));
        return service.evaluateStructured(req).get(0).passed();
    }

    @Test
    void structured_exact_treats_int_and_double_as_equal() {
        assertThat(structured("10", "10.0", "exact")).isTrue();
        assertThat(structured("10.0", "10", "exact")).isTrue();
        assertThat(structured("10", "11", "exact")).isFalse();
        assertThat(structured("\"abc\"", "\"abc\"", "exact")).isTrue();
    }

    @Test
    void structured_relational_modes_compare_against_a_hidden_bound() {
        assertThat(structured("70", "60", "gt")).isTrue();
        assertThat(structured("60", "60", "gt")).isFalse();
        assertThat(structured("60", "60", "ge")).isTrue();
        assertThat(structured("2", "3", "lt")).isTrue();
        assertThat(structured("3", "3", "lt")).isFalse();
        assertThat(structured("3", "3", "le")).isTrue();
        assertThat(structured("4", "3", "le")).isFalse();
    }

    @Test
    void structured_relational_on_non_number_fails() {
        assertThat(structured("\"abc\"", "60", "gt")).isFalse();
    }

    @Test
    void structured_ne_mode() {
        assertThat(structured("5", "6", "ne")).isTrue();
        assertThat(structured("6", "6", "ne")).isFalse();
        assertThat(structured("\"a\"", "\"b\"", "ne")).isTrue();
        assertThat(structured("\"a\"", "\"a\"", "ne")).isFalse();
    }

    @Test
    void structured_contains_mode() {
        assertThat(structured("\"hello world\"", "\"world\"", "contains")).isTrue();
        assertThat(structured("\"hello\"", "\"world\"", "contains")).isFalse();
    }

    @Test
    void structured_contains_coerces_non_string_operands() {
        assertThat(structured("123", "\"2\"", "contains")).isTrue();     // valeur nombre → « 123 »
        assertThat(structured("\"abc\"", "null", "contains")).isTrue();  // borne vide (« ») → toujours contenue
    }

    @Test
    void structured_regex_mode_searches_a_pattern() {
        assertThat(structured("\"abc123\"", "\"\\\\d+\"", "regex")).isTrue();  // motif \d+
        assertThat(structured("\"abc\"", "\"\\\\d+\"", "regex")).isFalse();
        assertThat(structured("\"x\"", "\"[\"", "regex")).isFalse();           // motif invalide → échec
    }

    @Test
    void structured_unordered_mode_ignores_order() {
        assertThat(structured("[3,1,2]", "[1,2,3]", "unordered")).isTrue();
        assertThat(structured("[1,2]", "[1,2,3]", "unordered")).isFalse();
    }

    @Test
    void structured_unknown_mode_falls_back_to_exact() {
        assertThat(structured("10", "10", "bogus")).isTrue();
        assertThat(structured("10", "11", "bogus")).isFalse();
    }

    // ── Comparaison COMPOSÉE (plusieurs conditions ET/OU, priorité ET > OU) ──

    private static String cond(String compare, String value) {
        return "{\"compare\":\"" + compare + "\",\"value\":\"" + value + "\"}";
    }

    private static String compound(String conds, String conns) {
        return "{\"conditions\":[" + conds + "],\"connectors\":[" + conns + "]}";
    }

    @Test
    void structured_compound_range_with_and() {
        // 60 ≤ valeur < 100
        String c = compound(cond("ge", "60") + "," + cond("lt", "100"), "\"and\"");
        assertThat(structured("70", c, "compound")).isTrue();
        assertThat(structured("60", c, "compound")).isTrue();
        assertThat(structured("100", c, "compound")).isFalse();
        assertThat(structured("50", c, "compound")).isFalse();
    }

    @Test
    void structured_compound_alternatives_with_or() {
        // valeur == 10 OU valeur == 20
        String c = compound(cond("exact", "10") + "," + cond("exact", "20"), "\"or\"");
        assertThat(structured("20", c, "compound")).isTrue();
        assertThat(structured("10", c, "compound")).isTrue();
        assertThat(structured("15", c, "compound")).isFalse();
    }

    @Test
    void structured_compound_and_binds_tighter_than_or() {
        // (≥ 60 ET < 100) OU == 0
        String c = compound(
                cond("ge", "60") + "," + cond("lt", "100") + "," + cond("exact", "0"),
                "\"and\",\"or\"");
        assertThat(structured("70", c, "compound")).isTrue();  // groupe ET vrai
        assertThat(structured("0", c, "compound")).isTrue();   // dernier OU vrai
        assertThat(structured("150", c, "compound")).isFalse();// aucun
    }

    @Test
    void structured_compound_empty_conditions_fail() {
        assertThat(structured("5", "{\"conditions\":[],\"connectors\":[]}", "compound")).isFalse();
    }

    @Test
    void structured_fails_closed_when_stdout_has_extra_lines() {
        // Triche : le code étudiant a écrit une paire « statut+valeur » forgée AVANT le vrai émetteur,
        // donc la sortie a 2 lignes de trop (≠ 2·N+1). On refuse plutôt que de lire un verdict falsifié.
        pistonRun(files -> new PistonClient.Stage("1\n10\n1\n5\n", "", 0, null, null));
        StructuredEvaluateRequest req = new StructuredEvaluateRequest("go", null, "x",
                List.of(new StructuredCase("t", "return doubler(5)", M.readTree("10"), "exact", 1)));
        assertThat(service.evaluateStructured(req)).singleElement()
                .satisfies(r -> assertThat(r.passed()).isFalse());
    }

    @Test
    void chaque_appel_piston_occupe_une_place_du_sandbox() {
        // Limite globale d'UNE place, déjà occupée par l'appelant : tout appel Piston (run, harnais,
        // SQL en deux phases) doit passer par cette place, donc être refusé sans appeler Piston.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 0, 1);
        ExecutionService limited = new ExecutionService(assembler, piston, limiter);
        pistonRun(files -> new PistonClient.Stage("", nonceIn(files), 0, null, null));

        limiter.withSandboxSlot(() -> {
            assertThatThrownBy(() -> limited.run(new RunRequest("Python", null, "print(1)")))
                    .isInstanceOf(ExecutionBusyException.class);
            assertThatThrownBy(() -> limited.evaluate(oneTest("Python", "def f(): pass", "return True")))
                    .isInstanceOf(ExecutionBusyException.class);
            assertThatThrownBy(() -> limited.evaluate(oneTest("SQL", "UPDATE t SET n = 0", SQL_MUTATION_HARNESS)))
                    .isInstanceOf(ExecutionBusyException.class);
            return null;
        });
        verify(piston, never()).execute(anyString(), any(), any(), any());

        // Place rendue : la même exécution passe.
        assertThat(limited.evaluate(oneTest("Python", "def f(): pass", "return True")))
                .singleElement().satisfies(t -> assertThat(t.passed()).isTrue());
    }
}
