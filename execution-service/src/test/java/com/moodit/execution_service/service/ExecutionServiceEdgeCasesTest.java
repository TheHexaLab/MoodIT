package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.sandbox.RunnerExec;
import com.moodit.execution_service.sandbox.SandboxException;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.stubbing.Answer;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Compléments à {@link ExecutionServiceTest} (RunnerExec mocké, assembleur réel) : exécution simple
 * (« run »), messages d'échec exposés au prof, verdict SQL (cas dégradés) et chemins d'échec de
 * l'exécution SQL isolée en deux phases. Chaque test fige le MESSAGE exact renvoyé : c'est ce que
 * voit le prof qui met au point son harnais.
 */
class ExecutionServiceEdgeCasesTest {

    private final CodeAssembler assembler = new CodeAssembler("/nonexistent-vendor");
    private final RunnerExec runner = mock(RunnerExec.class);
    private final ExecutionService service = new ExecutionService(assembler, runner);

    private static final Pattern NONCE = Pattern.compile("MOODIT_OK_[0-9a-f]+");

    private static String nonceIn(List<RunnerExec.File> files) {
        for (RunnerExec.File f : files) {
            Matcher m = NONCE.matcher(f.content());
            if (m.find()) return m.group();
        }
        return "";
    }

    private static RunnerExec.Stage stage(String stdout, String stderr, Integer code, String signal, String message) {
        return new RunnerExec.Stage(stdout, stderr, code, signal, message);
    }

    /** Le runner (mode exec) renvoie le résultat calculé à partir des fichiers soumis. */
    private void runnerReturns(Function<List<RunnerExec.File>, RunnerExec.Result> fn) {
        // Re-programmation : on repart d'un mock vierge (sinon when(...) rappelle l'ancienne réponse).
        reset(runner);
        when(runner.execute(anyString(), any(), any(), any())).thenAnswer((Answer<RunnerExec.Result>) inv ->
                fn.apply(inv.getArgument(1)));
    }

    private void runnerRun(Function<List<RunnerExec.File>, RunnerExec.Stage> runFn) {
        runnerReturns(files -> new RunnerExec.Result(null, runFn.apply(files), null));
    }

    @Test
    void code_with_a_nul_byte_is_refused_before_any_container_in_every_language() {
        // #23 : sqlite3 lit son programme ligne par ligne et s'arrête au NUL ; une chaîne fermée
        // pour le découpeur Java restait ouverte, et la suite sortait de la vue de la réponse.
        String forge = "SELECT 'a" + (char) 0 + "\n';\n.print X\n--'";
        for (String language : List.of("SQL", "Python", "Java", "Bash")) {
            List<TestResult> r = service.evaluate(new EvaluateRequest(language, null, forge,
                    List.of(new TestCaseInput("a", "SELECT 1;", 2), new TestCaseInput("b", "SELECT 1;", 3))));
            assertThat(r).extracting(TestResult::name, TestResult::weight, TestResult::passed)
                    .containsExactly(org.assertj.core.groups.Tuple.tuple("a", 2, false),
                            org.assertj.core.groups.Tuple.tuple("b", 3, false));
            assertThat(r).allSatisfy(t -> assertThat(t.detail()).contains("caractère nul"));
        }
        verifyNoInteractions(runner);
    }

    private TestResult single(String language, String code, String harness) {
        List<TestResult> r = service.evaluate(new EvaluateRequest(language, null, code,
                List.of(new TestCaseInput("t", harness, 1))));
        assertThat(r).hasSize(1);
        return r.get(0);
    }

    private static String sqlFenced(List<RunnerExec.File> files, String body) {
        String nonce = nonceIn(files);
        return CodeAssembler.sqlVerdictStart(nonce) + "\n" + body + "\n" + CodeAssembler.sqlVerdictEnd(nonce) + "\n";
    }

    // ── run() : exécution simple ────────────────────────────────────────────────

    @Test
    void run_sends_raw_code_and_returns_output() {
        when(runner.execute(eq("python"), any(), any(), any()))
                .thenReturn(new RunnerExec.Result(null, stage("bonjour\n", "", 0, null, null), null));

        RunResult r = service.run(new RunRequest("Python", null, "print('bonjour')"));

        assertThat(r).isEqualTo(new RunResult("bonjour\n", "", 0, null, null, false));
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<RunnerExec.File>> files = ArgumentCaptor.forClass(List.class);
        verify(runner).execute(eq("python"), files.capture(), any(), any());
        assertThat(files.getValue()).containsExactly(new RunnerExec.File("main.py", "print('bonjour')"));
    }

    @Test
    void run_exception_du_programme_n_est_pas_une_erreur_et_garde_stderr() {
        runnerRun(f -> stage("", "Traceback: ZeroDivisionError", 1, null, null));

        RunResult r = service.run(new RunRequest("Python", null, "1/0"));

        assertThat(r).isEqualTo(new RunResult("", "Traceback: ZeroDivisionError", 1, null, null, false));
    }

    @Test
    void run_echec_de_compilation_remonte_la_sortie_de_compilation() {
        runnerReturns(f -> new RunnerExec.Result(stage("", "main.c:1: erreur", 1, null, null), null, null));

        RunResult r = service.run(new RunRequest("C", null, "int main( {"));

        assertThat(r).isEqualTo(new RunResult("", "main.c:1: erreur", 1, null, "main.c:1: erreur", false));
    }

    @Test
    void run_echec_de_compilation_sans_stderr_utilise_le_message_puis_un_libelle_par_defaut() {
        runnerReturns(f -> new RunnerExec.Result(stage("sortie compil", "  ", 2, "SIGTERM", "msg du runner"), null, null));
        RunResult withMessage = service.run(new RunRequest("C", null, "x"));
        // stderr vide → message ; la sortie de compil retombe sur stdout ; le signal est transmis.
        assertThat(withMessage).isEqualTo(new RunResult("", "msg du runner", 2, "SIGTERM", "sortie compil", false));

        runnerReturns(f -> new RunnerExec.Result(stage(null, null, 1, null, null), null, null));
        RunResult bare = service.run(new RunRequest("C", null, "x"));
        assertThat(bare).isEqualTo(new RunResult("", "Échec de compilation", 1, null, null, false));
    }

    @Test
    void run_killed_compilation_reported_as_interrupted() {
        // Le superviseur rend une compilation tuée SANS code, avec un signal, et sans étape run.
        runnerReturns(f -> new RunnerExec.Result(stage("", "", null, "SIGKILL", null), null, null));

        RunResult r = service.run(new RunRequest("TypeScript", null, "let x = 1"));

        assertThat(r.stderr()).startsWith("Interrompu à la compilation (signal SIGKILL)");
        assertThat(r.signal()).isEqualTo("SIGKILL");
        assertThat(r.timedOut()).isTrue();
    }

    @Test
    void evaluate_killed_compilation_fails_case_with_interrupted_detail() {
        runnerReturns(f -> new RunnerExec.Result(stage("", "", null, "SIGKILL", null), null, null));

        List<TestResult> r = service.evaluate(new EvaluateRequest("TypeScript", null, "let x = 1",
                List.of(new TestCaseInput("cas", "return true;", 1))));

        assertThat(r).singleElement().satisfies(t -> {
            assertThat(t.passed()).isFalse();
            assertThat(t.detail()).startsWith("Interrompu à la compilation");
        });
    }

    @Test
    void run_compilation_reussie_transmet_sa_sortie_avec_celle_du_programme() {
        runnerReturns(f -> new RunnerExec.Result(stage("", "warning: unused", 0, null, null),
                stage("42", "", 0, null, null), null));

        RunResult r = service.run(new RunRequest("C", null, "int main(){}"));

        assertThat(r).isEqualTo(new RunResult("42", "", 0, null, "warning: unused", false));
    }

    @Test
    void run_compilation_au_code_absent_n_est_pas_un_echec() {
        runnerReturns(f -> new RunnerExec.Result(stage("", "", null, null, null), stage("ok", "", 0, null, null), null));

        assertThat(service.run(new RunRequest("Rust", null, "fn main(){}")).stdout()).isEqualTo("ok");
    }

    @Test
    void run_sans_etape_run_renvoie_un_message_explicite() {
        runnerReturns(f -> new RunnerExec.Result(null, null, null));

        RunResult r = service.run(new RunRequest("Python", null, ""));

        assertThat(r).isEqualTo(new RunResult("", "Aucune sortie d'exécution", null, null, null, false));
    }

    @Test
    void run_interrompu_par_un_signal_est_marque_timedOut_et_sorties_nulles_vides() {
        runnerRun(f -> stage(null, null, null, "SIGKILL", null));

        RunResult r = service.run(new RunRequest("Python", null, "while True: pass"));

        assertThat(r).isEqualTo(new RunResult("", "", null, "SIGKILL", null, true));
    }

    @Test
    void run_tronque_les_sorties_trop_longues() {
        String big = "a".repeat(20_001);
        String exact = "b".repeat(20_000);
        runnerRun(f -> stage(big, exact, 0, null, null));

        RunResult r = service.run(new RunRequest("Python", null, "print('a'*20001)"));

        assertThat(r.stdout()).isEqualTo("a".repeat(20_000) + "\n… (sortie tronquée)");
        assertThat(r.stderr()).isEqualTo(exact);   // exactement à la limite : intact
    }

    @Test
    void run_unsupported_language_starts_no_container() {
        assertThatThrownBy(() -> service.run(new RunRequest("HTML", null, "<p>")))
                .isInstanceOf(UnsupportedLanguageException.class);
        verify(runner, never()).execute(anyString(), any(), any(), any());
    }

    @Test
    void run_runner_error_is_propagated() {
        when(runner.execute(anyString(), any(), any(), any())).thenThrow(new SandboxException("injoignable"));

        assertThatThrownBy(() -> service.run(new RunRequest("Python", null, "")))
                .isInstanceOf(SandboxException.class).hasMessage("injoignable");
    }

    // ── evaluate() : verdict et messages d'échec ────────────────────────────────

    @Test
    void evaluate_passes_normalized_runtime_to_runner() {
        runnerRun(f -> stage("", nonceIn(f), 0, null, null));

        service.evaluate(new EvaluateRequest("Python", null, "def f(): pass",
                List.of(new TestCaseInput("t", "return True", 1))));

        verify(runner).execute(eq("python"), any(), any(), any());
    }

    @Test
    void evaluate_nonce_sur_stdout_vaut_aussi_reussite() {
        runnerRun(f -> stage("bruit " + nonceIn(f), "", 0, null, null));

        TestResult t = single("Python", "def f(): pass", "return True");

        assertThat(t.passed()).isTrue();
        assertThat(t.detail()).isNull();
    }

    @Test
    void evaluate_nonce_present_mais_signal_vaut_echec() {
        runnerRun(f -> stage("", nonceIn(f), null, "SIGKILL", null));

        TestResult t = single("Python", "def f(): pass", "return True");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Interrompu (signal SIGKILL) — dépassement de temps ou de mémoire probable");
    }

    @Test
    void evaluate_chaque_harnais_a_son_propre_nonce() {
        // Anti-triche : le nonce d'un test ne permet pas de réussir un autre test.
        List<String> nonces = new ArrayList<>();
        runnerRun(f -> {
            nonces.add(nonceIn(f));
            // Le 2e appel renvoie le nonce du 1er : doit échouer.
            return stage("", nonces.get(0), 0, null, null);
        });

        List<TestResult> r = service.evaluate(new EvaluateRequest("Python", null, "def f(): pass", List.of(
                new TestCaseInput("premier", "return True", 2),
                new TestCaseInput("second", "return True", null))));

        assertThat(nonces).hasSize(2).doesNotHaveDuplicates().allMatch(n -> n.matches("MOODIT_OK_[0-9a-f]{48}"));
        assertThat(r).extracting(TestResult::name).containsExactly("premier", "second");
        assertThat(r).extracting(TestResult::passed).containsExactly(true, false);
        assertThat(r).extracting(TestResult::weight).containsExactly(2, 1); // poids absent → 1
    }

    @Test
    void evaluate_sans_etape_run_echoue_avec_message() {
        runnerReturns(f -> new RunnerExec.Result(null, null, null));

        TestResult t = single("Python", "", "return True");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Aucune sortie d'exécution");
    }

    @Test
    void evaluate_detail_d_echec_stderr_puis_message_puis_libelle_par_defaut() {
        runnerRun(f -> stage("", "AssertionError", 1, null, "msg"));
        assertThat(single("Python", "", "return False").detail()).isEqualTo("AssertionError");

        runnerRun(f -> stage("", " ", 1, null, "msg"));
        assertThat(single("Python", "", "return False").detail()).isEqualTo("msg");

        runnerRun(f -> stage("", null, 1, null, null));
        assertThat(single("Python", "", "return False").detail()).isEqualTo("Le harnais a renvoyé faux");
    }

    @Test
    void evaluate_detail_d_echec_est_borne_a_2000_caracteres() {
        runnerRun(f -> stage("", "e".repeat(5000), 1, null, null));

        assertThat(single("Python", "", "return False").detail()).isEqualTo("e".repeat(2000));
    }

    @Test
    void evaluate_echec_de_compilation_sans_stderr() {
        // TypeScript : seul langage encore assemblé avec une étape de compilation (#116).
        // Chemin RÉEL du runner : tsc écrit ses diagnostics sur STDOUT, stderr vide (rejoué dans
        // moodit-runner-node), et le superviseur n'alimente jamais `message` — cf.
        // RunnerExec.Stage. Seul stderr était lu : le détail se réduisait à « Échec de
        // compilation », sans dire où.
        runnerReturns(f -> new RunnerExec.Result(
                stage("main.ts(1,12): error TS1138", "", 2, null, null), null, null));
        assertThat(single("TypeScript", "", "return true;").detail())
                .isEqualTo("main.ts(1,12): error TS1138");
        // stderr garde la priorité quand il est renseigné.
        runnerReturns(f -> new RunnerExec.Result(stage("bruit", "erreur tsc", 1, null, null), null, null));
        assertThat(single("TypeScript", "", "return true;").detail()).isEqualTo("erreur tsc");

        runnerReturns(f -> new RunnerExec.Result(stage("", "", 1, null, null), null, null));
        TestResult t = single("TypeScript", "", "return true;");
        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Échec de compilation");
    }

    // ── SQL lecture seule : verdict dégradé ─────────────────────────────────────

    @Test
    void sql_sans_etape_run() {
        runnerReturns(f -> new RunnerExec.Result(null, null, null));

        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Aucune sortie SQL");
    }

    @Test
    void sql_interrompu_par_un_signal() {
        runnerRun(f -> stage(sqlFenced(f, "1"), "", null, "SIGKILL", null));

        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Interrompu (signal SIGKILL) — dépassement de temps ou de mémoire probable");
    }

    @Test
    void sql_erreur_d_execution_remonte_stderr_sinon_message_sinon_libelle() {
        runnerRun(f -> stage("", "no such table: t", 1, null, null));
        assertThat(single("SQL", "SELECT * FROM t", "SELECT 1;").detail()).isEqualTo("no such table: t");

        runnerRun(f -> stage("", "", 1, null, "msg"));
        assertThat(single("SQL", "SELECT 1", "SELECT 1;").detail()).isEqualTo("msg");

        runnerRun(f -> stage("", "", 1, null, null));
        assertThat(single("SQL", "SELECT 1", "SELECT 1;").detail()).isEqualTo("Erreur SQL");
    }

    @Test
    void sql_verdict_introuvable_remonte_stderr_sinon_message_par_defaut() {
        runnerRun(f -> stage("1\n", "Parse error near line 3", 0, null, null));
        assertThat(single("SQL", "SELECT 1", "SELECT 1;").detail()).isEqualTo("Parse error near line 3");

        runnerRun(f -> stage(null, null, 0, null, null));
        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");
        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Verdict du harnais introuvable (sortie corrompue ?)");
    }

    @Test
    void sql_sentinelle_de_fin_absente_vaut_verdict_introuvable() {
        runnerRun(f -> stage(CodeAssembler.sqlVerdictStart(nonceIn(f)) + "\n1\n", "", 0, null, null));

        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Verdict du harnais introuvable (sortie corrompue ?)");
    }

    @Test
    void sql_verdict_null_est_rapporte_comme_aucune_valeur() {
        runnerRun(f -> stage(sqlFenced(f, ""), "", 0, null, null));

        TestResult t = single("SQL", "SELECT 1", "SELECT NULL;");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Le harnais a renvoyé faux (valeur : aucune)");
    }

    @Test
    void sql_verdict_faux_rapporte_la_valeur_lue() {
        runnerRun(f -> stage(sqlFenced(f, "0"), "", 0, null, null));

        assertThat(single("SQL", "SELECT 1", "SELECT 0;").detail()).isEqualTo("Le harnais a renvoyé faux (valeur : 0)");
    }

    @Test
    void sql_verdict_est_la_derniere_ligne_non_vide_entre_sentinelles() {
        // Sentinelles entourées d'espaces (\r de fin de ligne, etc.) : tolérées.
        runnerRun(f -> {
            String n = nonceIn(f);
            return stage("  " + CodeAssembler.sqlVerdictStart(n) + " \r\n0\n  1  \n\n"
                    + CodeAssembler.sqlVerdictEnd(n) + "\r\n", "", 0, null, null);
        });

        assertThat(single("SQL", "SELECT 1", "SELECT 0; SELECT 1;").passed()).isTrue();
    }

    @Test
    void sql_duplicated_start_sentinel_fails_the_verdict() {
        // #23 : le programme n'imprime qu'un bloc. Un second, avant ou après le vrai, vient d'une
        // sortie forgée : le verdict n'est lu dans aucun des deux.
        runnerRun(f -> stage(sqlFenced(f, "1") + sqlFenced(f, "1"), "", 0, null, null));
        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");
        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Verdict du harnais introuvable (sortie corrompue ?)");

        // Début seul en double, sans seconde fin : même refus.
        runnerRun(f -> stage(CodeAssembler.sqlVerdictStart(nonceIn(f)) + "\n" + sqlFenced(f, "1"),
                "", 0, null, null));
        assertThat(single("SQL", "SELECT 1", "SELECT 1;").passed()).isFalse();

        // Une fin en double, elle, ne gêne pas : le bloc s'arrête à la première.
        runnerRun(f -> stage(sqlFenced(f, "1") + CodeAssembler.sqlVerdictEnd(nonceIn(f)) + "\n",
                "", 0, null, null));
        assertThat(single("SQL", "SELECT 1", "SELECT 1;").passed()).isTrue();
    }

    // ── SQL modification : chemins d'échec des deux phases ─────────────────────

    private static final String MUTATION_HARNESS =
            "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(1);\n-- @student\nSELECT (SELECT n FROM t) = 0;";

    private static boolean isPhase1(List<RunnerExec.File> files) {
        return files.get(0).content().contains(".dump");
    }

    private static String dump(List<RunnerExec.File> files, String body) {
        String n = nonceIn(files);
        return CodeAssembler.sqlDumpStart(n) + "\n" + body + CodeAssembler.sqlDumpEnd(n) + "\n";
    }

    @Test
    void sql_modification_phase1_sans_run_ou_interrompue() {
        runnerReturns(f -> new RunnerExec.Result(null, null, null));
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).detail())
                .isEqualTo("Interrompu en phase 1 (dépassement de temps ou de mémoire probable)");

        runnerRun(f -> stage("", "", null, "SIGKILL", null));
        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);
        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Interrompu en phase 1 (dépassement de temps ou de mémoire probable)");
    }

    @Test
    void sql_modification_erreur_en_phase1_remonte_le_stderr_etudiant_sans_phase2() {
        runnerRun(f -> stage("", "near \"x\": syntax error", 1, null, null));

        TestResult t = single("SQL", "x", MUTATION_HARNESS);

        assertThat(t.detail()).isEqualTo("near \"x\": syntax error");
        verify(runner, times(1)).execute(eq("sqlite3"), any(), any(), any());
    }

    @Test
    void sql_modification_erreur_en_phase1_sans_stderr() {
        runnerRun(f -> stage("", "", 1, null, null));

        assertThat(single("SQL", "x", MUTATION_HARNESS).detail()).isEqualTo("Erreur SQL (ton code)");
    }

    @Test
    void sql_modification_dump_introuvable() {
        // L'étudiant a avalé les sentinelles (ex. commentaire non fermé) : pas de dump lisible.
        runnerRun(f -> stage("1\n", "", 0, null, null));

        TestResult t = single("SQL", "/*", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("État de la base introuvable après ton code");
        verify(runner, times(1)).execute(anyString(), any(), any(), any());

        // Début du dump en double (#23) : sortie forgée, le dump n'est pas relu, pas de phase 2.
        runnerRun(f -> isPhase1(f)
                ? stage(CodeAssembler.sqlDumpStart(nonceIn(f)) + "\n" + dump(f, "CREATE TABLE t(n INT);\n"),
                        "", 0, null, null)
                : stage(sqlFenced(f, "1"), "", 0, null, null));
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).detail())
                .isEqualTo("État de la base introuvable après ton code");
        verify(runner, times(1)).execute(anyString(), any(), any(), any());
    }

    @Test
    void sql_modification_dump_nonce_is_not_the_verdict_nonce() {
        // #23 : le code soumis tourne en phase 1 ; rien de ce qui s'y trouve ne vaut en phase 2.
        List<String> nonces = new ArrayList<>();
        runnerRun(f -> {
            nonces.add(nonceIn(f));
            return isPhase1(f)
                    ? stage(dump(f, "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(0);\n"), "", 0, null, null)
                    : stage(sqlFenced(f, "1"), "", 0, null, null);
        });

        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).passed()).isTrue();
        assertThat(nonces).hasSize(2).doesNotContain("").doesNotHaveDuplicates();

        // Le verdict encadré par le nonce du DUMP ne compte pas.
        String[] dumpNonce = new String[1];
        runnerRun(f -> {
            if (isPhase1(f)) {
                dumpNonce[0] = nonceIn(f);
                return stage(dump(f, "CREATE TABLE t(n INT);\n"), "", 0, null, null);
            }
            return stage(CodeAssembler.sqlVerdictStart(dumpNonce[0]) + "\n1\n"
                    + CodeAssembler.sqlVerdictEnd(dumpNonce[0]) + "\n", "", 0, null, null);
        });
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).passed()).isFalse();
    }

    @Test
    void sql_modification_dump_trop_volumineux_est_refuse_sans_phase2() {
        ReflectionTestUtils.setField(service, "maxSqlDumpChars", 50);
        runnerRun(f -> stage(dump(f, "INSERT INTO t VALUES(" + "9".repeat(60) + ");\n"), "", 0, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("État de la base trop volumineux");
        verify(runner, times(1)).execute(anyString(), any(), any(), any());
    }

    @Test
    void sql_modification_schema_rewritten_with_a_parameter_is_refused_without_phase2() {
        // Revue #246 : sqlite_master réécrit en phase 1 (writable_schema) ; le `$x(/*)` cachait
        // une vue TEMP qui s'exécutait en phase 2. Dump refusé, la phase 2 ne part pas.
        runnerRun(f -> isPhase1(f)
                ? stage(dump(f, "CREATE TABLE t(n INT);INSERT INTO t VALUES($x(/*),0);"
                        + "CREATE TEMP VIEW t AS SELECT 0 AS n;SELECT 1 /* */;\n"), "", 0, null, null)
                : stage(sqlFenced(f, "1"), "", 0, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("État de la base invalide après ton code");
        verify(runner, times(1)).execute(anyString(), any(), any(), any());
    }

    @Test
    void sql_modification_dump_truncated_by_the_supervisor_is_refused() {
        // #23 : au-delà de son plafond en octets, le superviseur garde la tête et la queue de la
        // sortie. Les sentinelles survivent, le dump a perdu son milieu (la ligne fautive avec) :
        // la phase 2 ne doit pas noter cet état partiel.
        runnerRun(f -> isPhase1(f)
                ? stage(dump(f, "CREATE TABLE t(n INT);\nINSERT INTO t VALUES('漢\n"
                        + "… (sortie tronquée au milieu : 1200055 octets)\n漢');\n"), "", 0, null, null)
                : stage(sqlFenced(f, "1"), "", 0, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("État de la base trop volumineux");
        verify(runner, times(1)).execute(anyString(), any(), any(), any());
        assertThat(ExecutionService.SUPERVISOR_TRUNCATION_MARKER).isEqualTo("(sortie tronquée au milieu");

        // Sortie de débogage géante AVANT le dump : c'est elle que la coupe a touchée, le dump
        // est complet. La réponse est notée normalement (phase 2 lancée).
        runnerRun(f -> isPhase1(f)
                ? stage("ligne\n… (sortie tronquée au milieu : 1200048 octets)\nligne\n"
                        + dump(f, "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(0);\n"), "", 0, null, null)
                : stage(sqlFenced(f, "1"), "", 0, null, null));
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).passed()).isTrue();
        verify(runner, times(2)).execute(anyString(), any(), any(), any());
    }

    @Test
    void sql_modification_dump_exactement_a_la_limite_est_accepte() {
        ReflectionTestUtils.setField(service, "maxSqlDumpChars", 50);
        String body = "-- " + "x".repeat(47); // dump relu : exactement 50 caractères
        runnerRun(f -> isPhase1(f)
                ? stage(dump(f, body + "\n"), "", 0, null, null)
                : stage(sqlFenced(f, "1"), "", 0, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);

        assertThat(body).hasSize(50);
        assertThat(t.passed()).isTrue();
        verify(runner, times(2)).execute(anyString(), any(), any(), any());
    }

    @Test
    void sql_modification_phase2_ne_recharge_que_les_tables_du_prof() {
        List<String> phase2 = new ArrayList<>();
        runnerRun(f -> {
            if (isPhase1(f)) {
                return stage("bruit étudiant\n" + dump(f, "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n"
                        + "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(0);\n"
                        + "CREATE TABLE triche(x);\nINSERT INTO triche VALUES(1);\n"
                        + "CREATE VIEW v AS SELECT 1;\nCOMMIT;\n"), "", 0, null, null);
            }
            phase2.add(f.get(0).content());
            return stage(sqlFenced(f, "1"), "", 0, null, null);
        });

        assertThat(single("SQL", "UPDATE t SET n = 0", MUTATION_HARNESS).passed()).isTrue();

        String nonce = phase2.isEmpty() ? "" : NONCE.matcher(phase2.get(0)).results().findFirst().orElseThrow().group();
        assertThat(phase2).singleElement().isEqualTo(
                "CREATE TABLE t(n INT)\n;\nINSERT INTO t VALUES(0)\n;\n"
                        + "SELECT '" + nonce + "_VERDICT_START';\n\nSELECT (SELECT n FROM t) = 0;\n;\n"
                        + "SELECT '" + nonce + "_VERDICT_END';\n");
    }

    @Test
    void sql_modification_erreur_en_phase2_ne_fuit_pas_le_stderr_du_harnais() {
        runnerRun(f -> isPhase1(f)
                ? stage(dump(f, "CREATE TABLE t(n INT);\n"), "", 0, null, null)
                : stage("", "no such table: reference_secrete", 1, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Le harnais n'a pas pu évaluer ton résultat");
    }

    @Test
    void sql_modification_phase2_sans_run_ou_interrompue() {
        runnerReturns(f -> isPhase1(f)
                ? new RunnerExec.Result(null, stage(dump(f, ""), "", 0, null, null), null)
                : new RunnerExec.Result(null, null, null));
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).detail())
                .isEqualTo("Le harnais n'a pas pu évaluer ton résultat");

        // Phase 2 INTERROMPUE par signal : meme prefixe « Interrompu » que les autres
        // interruptions, pour le prof. (La boucle d'evaluation, elle, lit le SIGNAL de l'etape
        // pour savoir que l'etudiant a consomme le budget — cf.
        // ExecutionServiceTest.budget_exhausted_by_interrupted_harness_stays_a_grade.)
        runnerRun(f -> isPhase1(f)
                ? stage(dump(f, ""), "", 0, null, null)
                : stage("", "", null, "SIGKILL", null));
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).detail())
                .startsWith("Interrompu en phase 2");
    }

    @Test
    void sql_modification_verdict_faux_en_phase2() {
        runnerRun(f -> isPhase1(f)
                ? stage(dump(f, "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(1);\n"), "", 0, null, null)
                : stage(sqlFenced(f, "0"), "", 0, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=n", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Le harnais a renvoyé faux (valeur : 0)");
    }
}
