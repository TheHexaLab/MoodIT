package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;

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
 * Mode « exec » côté Java (#116, ex-Piston) : construction du job (fichiers sous src/, entrée =
 * premier fichier, stdin, temps limite borné), choix de l'image par runtime, et parsing FAIL-CLOSED
 * de la réponse du superviseur (étapes compile/run au format Piston).
 */
class RunnerExecTest {

    private final DockerSandbox sandbox = mock(DockerSandbox.class);
    private final RunnerExec runner = new RunnerExec(sandbox, "moodit-runner-", "latest");

    private void supervisorReturns(String json) {
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun(json, "", 0));
    }

    @Test
    void image_per_runtime_and_unknown_rejected() {
        assertThat(runner.imageFor("python")).isEqualTo("moodit-runner-python:latest");
        assertThat(runner.imageFor("javascript")).isEqualTo("moodit-runner-node:latest");
        assertThat(runner.imageFor("typescript")).isEqualTo("moodit-runner-node:latest");
        assertThat(runner.imageFor("sqlite3")).isEqualTo("moodit-runner-sqlite:latest");
        assertThat(runner.imageFor("c++")).isEqualTo("moodit-runner-c:latest");
        assertThat(runner.imageFor(" Java ")).isEqualTo("moodit-runner-java:latest");
        assertThatThrownBy(() -> runner.imageFor("cobol"))
                .isInstanceOf(UnsupportedLanguageException.class);
    }

    @Test
    void builds_job_with_entry_first_file_and_stdin() {
        supervisorReturns("""
                {"v":1,"compile":null,
                 "run":{"stdout":"ok\\n","stderr":"","code":0,"signal":null}}
                """);
        RunnerExec.Result result = runner.execute("python",
                List.of(new RunnerExec.File("grader.py", "GRADER"),
                        new RunnerExec.File("student_server.py", "SERVEUR")),
                "secret\n", 5000);

        assertThat(result.compile()).isNull();
        assertThat(result.run()).isEqualTo(new RunnerExec.Stage("ok\n", "", 0, null, null));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, String>> files = ArgumentCaptor.forClass(Map.class);
        verify(sandbox).run(eq("moodit-runner-python:latest"), files.capture(), eq(80_000L));
        assertThat(files.getValue().get("src/grader.py")).isEqualTo("GRADER");
        assertThat(files.getValue().get("src/student_server.py")).isEqualTo("SERVEUR");
        assertThat(files.getValue().get("job.json"))
                .contains("\"mode\":\"exec\"")
                .contains("\"runtime\":\"python\"")
                .contains("\"entry\":\"grader.py\"")
                .contains("\"timeout_ms\":5000")
                .contains("\"stdin\":\"secret\\n\"");
    }

    @Test
    void time_limit_bounded_to_60s_default_3s() {
        supervisorReturns("{\"v\":1,\"compile\":null,\"run\":{\"stdout\":\"\",\"stderr\":\"\",\"code\":0,\"signal\":null}}");
        runner.execute("bash", List.of(new RunnerExec.File("main.sh", "x")), null, 999_999);
        verify(sandbox).run(any(), anyMap(), eq(75_000L + 60_000L));

        runner.execute("bash", List.of(new RunnerExec.File("main.sh", "x")));
        verify(sandbox).run(any(), anyMap(), eq(75_000L + 3_000L));
    }

    @Test
    void compile_stage_and_signal_mapped() {
        supervisorReturns("""
                {"v":1,
                 "compile":{"stdout":"","stderr":"erreur de syntaxe","code":2,"signal":null},
                 "run":null}
                """);
        RunnerExec.Result compileError = runner.execute("typescript",
                List.of(new RunnerExec.File("grader.ts", "x")), null, null);
        assertThat(compileError.compile().code()).isEqualTo(2);
        assertThat(compileError.compile().stderr()).isEqualTo("erreur de syntaxe");
        assertThat(compileError.run()).isNull();

        supervisorReturns("""
                {"v":1,"compile":null,
                 "run":{"stdout":"","stderr":"","code":null,"signal":"SIGKILL"}}
                """);
        RunnerExec.Result killed = runner.execute("python",
                List.of(new RunnerExec.File("main.py", "x")), null, null);
        assertThat(killed.run().code()).isNull();
        assertThat(killed.run().signal()).isEqualTo("SIGKILL");
    }

    @Test
    void unreadable_response_or_supervisor_error_fails_closed() {
        // Une sortie VIDE ne lève pas chez Jackson 3 (MissingNode) : sans garde, elle rendait
        // Result(null, null) → « Aucune sortie d'exécution », au lieu du 502 d'une panne.
        supervisorReturns("");
        assertThatThrownBy(() -> runner.execute("python",
                List.of(new RunnerExec.File("main.py", "x")), null, null))
                .isInstanceOf(SandboxException.class);

        supervisorReturns("pas du json");
        assertThatThrownBy(() -> runner.execute("python",
                List.of(new RunnerExec.File("main.py", "x")), null, null))
                .isInstanceOf(SandboxException.class);

        supervisorReturns("{\"v\":1,\"error\":\"runtime non pris en charge : cobol\"}");
        assertThatThrownBy(() -> runner.execute("python",
                List.of(new RunnerExec.File("main.py", "x")), null, null))
                .isInstanceOf(SandboxException.class)
                .hasMessageContaining("cobol");
    }

    @Test
    void no_file_is_rejected() {
        assertThatThrownBy(() -> runner.execute("python", List.of(), null, null))
                .isInstanceOf(SandboxException.class);
        assertThatThrownBy(() -> runner.execute("python", null, null, null))
                .isInstanceOf(SandboxException.class);
    }

    @Test
    void runtime_aliases_normalized_with_dedicated_images() {
        assertThat(runner.imageFor("csharp")).isEqualTo("moodit-runner-csharp:latest");
        assertThat(runner.imageFor("rust")).isEqualTo("moodit-runner-rust:latest");
        assertThat(runner.imageFor("  JAVA  ")).isEqualTo("moodit-runner-java:latest");
    }

    @Test
    void null_runtime_normalized_in_job() {
        supervisorReturns("{\"v\":1,\"compile\":null,\"run\":{\"stdout\":\"\",\"stderr\":\"\",\"code\":0,\"signal\":null}}");
        assertThatThrownBy(() -> runner.execute(null, List.of(new RunnerExec.File("x", "y"))))
                .isInstanceOf(RuntimeException.class);
    }
}
