package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonClient;
import com.moodit.execution_service.piston.PistonException;
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
import static org.mockito.Mockito.when;

/**
 * Compléments à {@link ExecutionServiceTest} (Piston mocké, assembleur réel) : exécution simple
 * (« run »), messages d'échec exposés au prof, verdict SQL (cas dégradés) et chemins d'échec de
 * l'exécution SQL isolée en deux phases. Chaque test fige le MESSAGE exact renvoyé : c'est ce que
 * voit le prof qui met au point son harnais.
 */
class ExecutionServiceEdgeCasesTest {

    private final CodeAssembler assembler = new CodeAssembler("/nonexistent-vendor");
    private final PistonClient piston = mock(PistonClient.class);
    private final ExecutionService service = new ExecutionService(assembler, piston);

    private static final Pattern NONCE = Pattern.compile("MOODIT_OK_[0-9a-f]+");

    private static String nonceIn(List<PistonClient.File> files) {
        for (PistonClient.File f : files) {
            Matcher m = NONCE.matcher(f.content());
            if (m.find()) return m.group();
        }
        return "";
    }

    private static PistonClient.Stage stage(String stdout, String stderr, Integer code, String signal, String message) {
        return new PistonClient.Stage(stdout, stderr, code, signal, message);
    }

    /** Piston renvoie le résultat calculé à partir des fichiers soumis. */
    private void piston(Function<List<PistonClient.File>, PistonClient.Result> fn) {
        // Re-programmation : on repart d'un mock vierge (sinon when(...) rappelle l'ancienne réponse).
        reset(piston);
        when(piston.execute(anyString(), any(), any())).thenAnswer((Answer<PistonClient.Result>) inv ->
                fn.apply(inv.getArgument(2)));
    }

    private void pistonRun(Function<List<PistonClient.File>, PistonClient.Stage> runFn) {
        piston(files -> new PistonClient.Result(null, runFn.apply(files), null));
    }

    private TestResult single(String language, String code, String harness) {
        List<TestResult> r = service.evaluate(new EvaluateRequest(language, null, code,
                List.of(new TestCaseInput("t", harness, 1))));
        assertThat(r).hasSize(1);
        return r.get(0);
    }

    private static String sqlFenced(List<PistonClient.File> files, String body) {
        String nonce = nonceIn(files);
        return CodeAssembler.sqlVerdictStart(nonce) + "\n" + body + "\n" + CodeAssembler.sqlVerdictEnd(nonce) + "\n";
    }

    // ── run() : exécution simple ────────────────────────────────────────────────

    @Test
    void run_envoie_le_code_brut_avec_la_version_et_renvoie_la_sortie() {
        when(piston.execute(eq("python"), eq("3.12"), any()))
                .thenReturn(new PistonClient.Result(null, stage("bonjour\n", "", 0, null, null), null));

        RunResult r = service.run(new RunRequest("Python", "3.12", "print('bonjour')"));

        assertThat(r).isEqualTo(new RunResult("bonjour\n", "", 0, null, null, false));
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<PistonClient.File>> files = ArgumentCaptor.forClass(List.class);
        verify(piston).execute(eq("python"), eq("3.12"), files.capture());
        assertThat(files.getValue()).containsExactly(new PistonClient.File("main.py", "print('bonjour')"));
    }

    @Test
    void run_exception_du_programme_n_est_pas_une_erreur_et_garde_stderr() {
        pistonRun(f -> stage("", "Traceback: ZeroDivisionError", 1, null, null));

        RunResult r = service.run(new RunRequest("Python", null, "1/0"));

        assertThat(r).isEqualTo(new RunResult("", "Traceback: ZeroDivisionError", 1, null, null, false));
    }

    @Test
    void run_echec_de_compilation_remonte_la_sortie_de_compilation() {
        piston(f -> new PistonClient.Result(stage("", "main.c:1: erreur", 1, null, null), null, null));

        RunResult r = service.run(new RunRequest("C", null, "int main( {"));

        assertThat(r).isEqualTo(new RunResult("", "main.c:1: erreur", 1, null, "main.c:1: erreur", false));
    }

    @Test
    void run_echec_de_compilation_sans_stderr_utilise_le_message_puis_un_libelle_par_defaut() {
        piston(f -> new PistonClient.Result(stage("sortie compil", "  ", 2, "SIGTERM", "msg Piston"), null, null));
        RunResult withMessage = service.run(new RunRequest("C", null, "x"));
        // stderr vide → message ; la sortie de compil retombe sur stdout ; le signal est transmis.
        assertThat(withMessage).isEqualTo(new RunResult("", "msg Piston", 2, "SIGTERM", "sortie compil", false));

        piston(f -> new PistonClient.Result(stage(null, null, 1, null, null), null, null));
        RunResult bare = service.run(new RunRequest("C", null, "x"));
        assertThat(bare).isEqualTo(new RunResult("", "Échec de compilation", 1, null, null, false));
    }

    @Test
    void run_compilation_reussie_transmet_sa_sortie_avec_celle_du_programme() {
        piston(f -> new PistonClient.Result(stage("", "warning: unused", 0, null, null),
                stage("42", "", 0, null, null), null));

        RunResult r = service.run(new RunRequest("C", null, "int main(){}"));

        assertThat(r).isEqualTo(new RunResult("42", "", 0, null, "warning: unused", false));
    }

    @Test
    void run_compilation_au_code_absent_n_est_pas_un_echec() {
        piston(f -> new PistonClient.Result(stage("", "", null, null, null), stage("ok", "", 0, null, null), null));

        assertThat(service.run(new RunRequest("Rust", null, "fn main(){}")).stdout()).isEqualTo("ok");
    }

    @Test
    void run_sans_etape_run_renvoie_un_message_explicite() {
        piston(f -> new PistonClient.Result(null, null, null));

        RunResult r = service.run(new RunRequest("Python", null, ""));

        assertThat(r).isEqualTo(new RunResult("", "Aucune sortie d'exécution", null, null, null, false));
    }

    @Test
    void run_interrompu_par_un_signal_est_marque_timedOut_et_sorties_nulles_vides() {
        pistonRun(f -> stage(null, null, null, "SIGKILL", null));

        RunResult r = service.run(new RunRequest("Python", null, "while True: pass"));

        assertThat(r).isEqualTo(new RunResult("", "", null, "SIGKILL", null, true));
    }

    @Test
    void run_tronque_les_sorties_trop_longues() {
        String big = "a".repeat(20_001);
        String exact = "b".repeat(20_000);
        pistonRun(f -> stage(big, exact, 0, null, null));

        RunResult r = service.run(new RunRequest("Python", null, "print('a'*20001)"));

        assertThat(r.stdout()).isEqualTo("a".repeat(20_000) + "\n… (sortie tronquée)");
        assertThat(r.stderr()).isEqualTo(exact);   // exactement à la limite : intact
    }

    @Test
    void run_langage_non_supporte_n_appelle_pas_piston() {
        assertThatThrownBy(() -> service.run(new RunRequest("HTML", null, "<p>")))
                .isInstanceOf(UnsupportedLanguageException.class);
        verify(piston, never()).execute(anyString(), any(), any());
    }

    @Test
    void run_erreur_piston_est_propagee() {
        when(piston.execute(anyString(), any(), any())).thenThrow(new PistonException("injoignable"));

        assertThatThrownBy(() -> service.run(new RunRequest("Python", null, "")))
                .isInstanceOf(PistonException.class).hasMessage("injoignable");
    }

    // ── evaluate() : verdict et messages d'échec ────────────────────────────────

    @Test
    void evaluate_transmet_langage_piston_et_version() {
        pistonRun(f -> stage("", nonceIn(f), 0, null, null));

        service.evaluate(new EvaluateRequest("Python", "3.10.0", "def f(): pass",
                List.of(new TestCaseInput("t", "return True", 1))));

        verify(piston).execute(eq("python"), eq("3.10.0"), any());
    }

    @Test
    void evaluate_nonce_sur_stdout_vaut_aussi_reussite() {
        pistonRun(f -> stage("bruit " + nonceIn(f), "", 0, null, null));

        TestResult t = single("Python", "def f(): pass", "return True");

        assertThat(t.passed()).isTrue();
        assertThat(t.detail()).isNull();
    }

    @Test
    void evaluate_nonce_present_mais_signal_vaut_echec() {
        pistonRun(f -> stage("", nonceIn(f), null, "SIGKILL", null));

        TestResult t = single("Python", "def f(): pass", "return True");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Interrompu (signal SIGKILL) — dépassement de temps ou de mémoire probable");
    }

    @Test
    void evaluate_chaque_harnais_a_son_propre_nonce() {
        // Anti-triche : le nonce d'un test ne permet pas de réussir un autre test.
        List<String> nonces = new ArrayList<>();
        pistonRun(f -> {
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
        piston(f -> new PistonClient.Result(null, null, null));

        TestResult t = single("Python", "", "return True");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Aucune sortie d'exécution");
    }

    @Test
    void evaluate_detail_d_echec_stderr_puis_message_puis_libelle_par_defaut() {
        pistonRun(f -> stage("", "AssertionError", 1, null, "msg"));
        assertThat(single("Python", "", "return False").detail()).isEqualTo("AssertionError");

        pistonRun(f -> stage("", " ", 1, null, "msg"));
        assertThat(single("Python", "", "return False").detail()).isEqualTo("msg");

        pistonRun(f -> stage("", null, 1, null, null));
        assertThat(single("Python", "", "return False").detail()).isEqualTo("Le harnais a renvoyé faux");
    }

    @Test
    void evaluate_detail_d_echec_est_borne_a_2000_caracteres() {
        pistonRun(f -> stage("", "e".repeat(5000), 1, null, null));

        assertThat(single("Python", "", "return False").detail()).isEqualTo("e".repeat(2000));
    }

    @Test
    void evaluate_echec_de_compilation_sans_stderr() {
        piston(f -> new PistonClient.Result(stage("", "", 1, null, "compile killed"), null, null));
        assertThat(single("C", "", "return 1;").detail()).isEqualTo("compile killed");

        piston(f -> new PistonClient.Result(stage("", "", 1, null, null), null, null));
        TestResult t = single("C", "", "return 1;");
        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Échec de compilation");
    }

    @Test
    void evaluate_compilation_reussie_puis_nonce_vaut_reussite() {
        piston(f -> new PistonClient.Result(stage("", "", 0, null, null), stage("", nonceIn(f), 0, null, null), null));

        assertThat(single("C", "int s(){return 1;}", "return s();").passed()).isTrue();
    }

    // ── SQL lecture seule : verdict dégradé ─────────────────────────────────────

    @Test
    void sql_sans_etape_run() {
        piston(f -> new PistonClient.Result(null, null, null));

        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Aucune sortie SQL");
    }

    @Test
    void sql_interrompu_par_un_signal() {
        pistonRun(f -> stage(sqlFenced(f, "1"), "", null, "SIGKILL", null));

        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Interrompu (signal SIGKILL) — dépassement de temps ou de mémoire probable");
    }

    @Test
    void sql_erreur_d_execution_remonte_stderr_sinon_message_sinon_libelle() {
        pistonRun(f -> stage("", "no such table: t", 1, null, null));
        assertThat(single("SQL", "SELECT * FROM t", "SELECT 1;").detail()).isEqualTo("no such table: t");

        pistonRun(f -> stage("", "", 1, null, "msg"));
        assertThat(single("SQL", "SELECT 1", "SELECT 1;").detail()).isEqualTo("msg");

        pistonRun(f -> stage("", "", 1, null, null));
        assertThat(single("SQL", "SELECT 1", "SELECT 1;").detail()).isEqualTo("Erreur SQL");
    }

    @Test
    void sql_verdict_introuvable_remonte_stderr_sinon_message_par_defaut() {
        pistonRun(f -> stage("1\n", "Parse error near line 3", 0, null, null));
        assertThat(single("SQL", "SELECT 1", "SELECT 1;").detail()).isEqualTo("Parse error near line 3");

        pistonRun(f -> stage(null, null, 0, null, null));
        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");
        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Verdict du harnais introuvable (sortie corrompue ?)");
    }

    @Test
    void sql_sentinelle_de_fin_absente_vaut_verdict_introuvable() {
        pistonRun(f -> stage(CodeAssembler.sqlVerdictStart(nonceIn(f)) + "\n1\n", "", 0, null, null));

        TestResult t = single("SQL", "SELECT 1", "SELECT 1;");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Verdict du harnais introuvable (sortie corrompue ?)");
    }

    @Test
    void sql_verdict_null_est_rapporte_comme_aucune_valeur() {
        pistonRun(f -> stage(sqlFenced(f, ""), "", 0, null, null));

        TestResult t = single("SQL", "SELECT 1", "SELECT NULL;");

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Le harnais a renvoyé faux (valeur : aucune)");
    }

    @Test
    void sql_verdict_faux_rapporte_la_valeur_lue() {
        pistonRun(f -> stage(sqlFenced(f, "0"), "", 0, null, null));

        assertThat(single("SQL", "SELECT 1", "SELECT 0;").detail()).isEqualTo("Le harnais a renvoyé faux (valeur : 0)");
    }

    @Test
    void sql_verdict_est_la_derniere_ligne_non_vide_entre_sentinelles() {
        // Sentinelles entourées d'espaces (\r de fin de ligne, etc.) : tolérées.
        pistonRun(f -> {
            String n = nonceIn(f);
            return stage("  " + CodeAssembler.sqlVerdictStart(n) + " \r\n0\n  1  \n\n"
                    + CodeAssembler.sqlVerdictEnd(n) + "\r\n", "", 0, null, null);
        });

        assertThat(single("SQL", "SELECT 1", "SELECT 0; SELECT 1;").passed()).isTrue();
    }

    // ── SQL modification : chemins d'échec des deux phases ─────────────────────

    private static final String MUTATION_HARNESS =
            "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(1);\n-- @student\nSELECT (SELECT n FROM t) = 0;";

    private static boolean isPhase1(List<PistonClient.File> files) {
        return files.get(0).content().contains(".dump");
    }

    private static String dump(List<PistonClient.File> files, String body) {
        String n = nonceIn(files);
        return CodeAssembler.sqlDumpStart(n) + "\n" + body + CodeAssembler.sqlDumpEnd(n) + "\n";
    }

    @Test
    void sql_modification_phase1_sans_run_ou_interrompue() {
        piston(f -> new PistonClient.Result(null, null, null));
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).detail())
                .isEqualTo("Interrompu en phase 1 (dépassement de temps ou de mémoire probable)");

        pistonRun(f -> stage("", "", null, "SIGKILL", null));
        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);
        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Interrompu en phase 1 (dépassement de temps ou de mémoire probable)");
    }

    @Test
    void sql_modification_erreur_en_phase1_remonte_le_stderr_etudiant_sans_phase2() {
        pistonRun(f -> stage("", "near \"x\": syntax error", 1, null, null));

        TestResult t = single("SQL", "x", MUTATION_HARNESS);

        assertThat(t.detail()).isEqualTo("near \"x\": syntax error");
        verify(piston, times(1)).execute(eq("sqlite3"), any(), any());
    }

    @Test
    void sql_modification_erreur_en_phase1_sans_stderr() {
        pistonRun(f -> stage("", "", 1, null, null));

        assertThat(single("SQL", "x", MUTATION_HARNESS).detail()).isEqualTo("Erreur SQL (ton code)");
    }

    @Test
    void sql_modification_dump_introuvable() {
        // L'étudiant a avalé les sentinelles (ex. commentaire non fermé) : pas de dump lisible.
        pistonRun(f -> stage("1\n", "", 0, null, null));

        TestResult t = single("SQL", "/*", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("État de la base introuvable après ton code");
        verify(piston, times(1)).execute(anyString(), any(), any());
    }

    @Test
    void sql_modification_dump_trop_volumineux_est_refuse_sans_phase2() {
        ReflectionTestUtils.setField(service, "maxSqlDumpChars", 50);
        pistonRun(f -> stage(dump(f, "INSERT INTO t VALUES(" + "9".repeat(60) + ");\n"), "", 0, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("État de la base trop volumineux");
        verify(piston, times(1)).execute(anyString(), any(), any());
    }

    @Test
    void sql_modification_phase2_ne_recharge_que_les_tables_du_prof() {
        List<String> phase2 = new ArrayList<>();
        pistonRun(f -> {
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
        pistonRun(f -> isPhase1(f)
                ? stage(dump(f, "CREATE TABLE t(n INT);\n"), "", 0, null, null)
                : stage("", "no such table: reference_secrete", 1, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Le harnais n'a pas pu évaluer ton résultat");
    }

    @Test
    void sql_modification_phase2_sans_run_ou_interrompue() {
        piston(f -> isPhase1(f)
                ? new PistonClient.Result(null, stage(dump(f, ""), "", 0, null, null), null)
                : new PistonClient.Result(null, null, null));
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).detail())
                .isEqualTo("Le harnais n'a pas pu évaluer ton résultat");

        pistonRun(f -> isPhase1(f)
                ? stage(dump(f, ""), "", 0, null, null)
                : stage("", "", null, "SIGKILL", null));
        assertThat(single("SQL", "UPDATE t SET n=0", MUTATION_HARNESS).detail())
                .isEqualTo("Le harnais n'a pas pu évaluer ton résultat");
    }

    @Test
    void sql_modification_verdict_faux_en_phase2() {
        pistonRun(f -> isPhase1(f)
                ? stage(dump(f, "CREATE TABLE t(n INT);\nINSERT INTO t VALUES(1);\n"), "", 0, null, null)
                : stage(sqlFenced(f, "0"), "", 0, null, null));

        TestResult t = single("SQL", "UPDATE t SET n=n", MUTATION_HARNESS);

        assertThat(t.passed()).isFalse();
        assertThat(t.detail()).isEqualTo("Le harnais a renvoyé faux (valeur : 0)");
    }
}
