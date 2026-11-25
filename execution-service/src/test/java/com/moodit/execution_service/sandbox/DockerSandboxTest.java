package com.moodit.execution_service.sandbox;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Conteneur runner (#116) : archive tar du job (chemins sous staging/, extraite dans /opt/moodit
 * puis déplacée vers /box par le superviseur ; fichiers 0600 ; sentinelle en dernier), cycle de
 * vie du conteneur et balayage des orphelins.
 */
class DockerSandboxTest {

    @Test
    void tar_places_files_under_staging_0600_and_ready_last() throws IOException {
        Map<String, String> files = new LinkedHashMap<>();
        files.put("job.json", "{}");
        files.put("cases/0/src/main.go", "package main");

        List<TarArchiveEntry> entries = new ArrayList<>();
        List<String> contents = new ArrayList<>();
        try (TarArchiveInputStream tar =
                new TarArchiveInputStream(new ByteArrayInputStream(DockerSandbox.tarOf(files)))) {
            TarArchiveEntry entry;
            while ((entry = tar.getNextEntry()) != null) {
                entries.add(entry);
                contents.add(new String(tar.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
        // Sous staging/ (extrait dans /opt/moodit, déplacé vers /box par le superviseur) ; .ready en dernier.
        assertThat(entries).extracting(TarArchiveEntry::getName)
                .containsExactly("staging/job.json", "staging/cases/0/src/main.go", "staging/.ready");
        // 0600 : illisible par l'UID étudiant dès l'extraction (le superviseur relâche les artefacts).
        assertThat(entries).allSatisfy(e -> assertThat(e.getMode() & 0777).isEqualTo(0600));
        assertThat(contents.get(1)).isEqualTo("package main");
    }

    @Test
    void tar_keeps_paths_longer_than_100_bytes() throws IOException {
        // Revue #246 : un nom de classe accepté de 200 caractères donne un chemin de plus de 100
        // octets ; sans le mode POSIX des noms longs, commons-compress refusait l'archive (502,
        // tentative supprimée).
        String path = "cases/0/src/" + "A".repeat(200) + ".java";
        List<String> names = new ArrayList<>();
        try (TarArchiveInputStream tar = new TarArchiveInputStream(
                new ByteArrayInputStream(DockerSandbox.tarOf(Map.of(path, "class A {}"))))) {
            TarArchiveEntry entry;
            while ((entry = tar.getNextEntry()) != null) {
                names.add(entry.getName());
            }
        }
        assertThat(names).containsExactly("staging/" + path, "staging/.ready");
    }

    @Test
    void default_docker_host_depends_on_os() {
        String host = DockerSandbox.defaultDockerHost();
        if (System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win")) {
            assertThat(host).startsWith("npipe://");
        } else {
            assertThat(host).startsWith("unix://");
        }
    }

    // ── Démon injoignable : échec PROPRE (SandboxException / false), jamais un faux verdict ──
    // tcp vers un port fermé de localhost : refus immédiat, aucun démon requis par ces tests.

    private final DockerSandbox unreachable = new DockerSandbox("tcp://127.0.0.1:1", 512, 64, 1.0);

    @Test
    void unreachable_daemon_available_and_image_present_return_false() {
        assertThat(unreachable.available()).isFalse();
        // Second appel : le client déjà initialisé est réutilisé (chemin rapide).
        assertThat(unreachable.available()).isFalse();
        assertThat(unreachable.imagePresent("moodit-runner-go:latest")).isFalse();
    }

    @Test
    void unreachable_daemon_run_throws_sandbox_exception() {
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> unreachable.run("moodit-runner-go:latest", Map.of("job.json", "{}"), 1000))
                .isInstanceOf(SandboxException.class);
    }

    @Test
    void invalid_docker_host_fails_with_sandbox_exception_on_first_run() {
        // L'initialisation paresseuse du client échoue (URI invalide) → message « injoignable ».
        DockerSandbox invalid = new DockerSandbox("::pas-une-uri::", 512, 64, 1.0);
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> invalid.run("img", Map.of(), 1000))
                .isInstanceOf(SandboxException.class)
                .hasMessageContaining("injoignable");
    }

    @Test
    void image_present_tells_missing_from_daemon_error() {
        var docker = org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        var inspect = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InspectImageCmd.class);
        org.mockito.Mockito.when(docker.inspectImageCmd("absente")).thenReturn(inspect);
        org.mockito.Mockito.when(inspect.exec())
                .thenThrow(new com.github.dockerjava.api.exception.NotFoundException("no such image"));
        var present = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InspectImageCmd.class);
        org.mockito.Mockito.when(docker.inspectImageCmd("presente")).thenReturn(present);

        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);
        assertThat(sandbox.imagePresent("absente")).isFalse();
        assertThat(sandbox.imagePresent("presente")).isTrue();
    }

    // ── Cycle de vie du conteneur, client Docker MOCKÉ (le vrai démon relève de
    // RpcGradingIntegrationTest ; ici on vérifie l'orchestration et le nettoyage) ──

    private com.github.dockerjava.api.DockerClient dockerMock(
            com.github.dockerjava.api.command.CreateContainerCmd create,
            com.github.dockerjava.api.command.RemoveContainerCmd remove,
            Integer waitStatus) {
        var docker = org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        org.mockito.Mockito.when(docker.createContainerCmd("img")).thenReturn(create);
        org.mockito.Mockito.when(create.withHostConfig(org.mockito.ArgumentMatchers.any())).thenReturn(create);
        org.mockito.Mockito.when(create.withLabels(org.mockito.ArgumentMatchers.<java.util.Map<String, String>>any())).thenReturn(create);

        var copy = org.mockito.Mockito.mock(com.github.dockerjava.api.command.CopyArchiveToContainerCmd.class);
        org.mockito.Mockito.when(docker.copyArchiveToContainerCmd("cid")).thenReturn(copy);
        org.mockito.Mockito.when(copy.withTarInputStream(org.mockito.ArgumentMatchers.any())).thenReturn(copy);
        org.mockito.Mockito.when(copy.withRemotePath("/opt/moodit")).thenReturn(copy);

        var start = org.mockito.Mockito.mock(com.github.dockerjava.api.command.StartContainerCmd.class);
        org.mockito.Mockito.when(docker.startContainerCmd("cid")).thenReturn(start);

        var wait = org.mockito.Mockito.mock(com.github.dockerjava.api.command.WaitContainerCmd.class);
        org.mockito.Mockito.when(docker.waitContainerCmd("cid")).thenReturn(wait);
        var waitCb = org.mockito.Mockito.mock(
                com.github.dockerjava.api.command.WaitContainerResultCallback.class);
        org.mockito.Mockito.when(wait.start()).thenReturn(waitCb);
        if (waitStatus != null) {
            org.mockito.Mockito.when(waitCb.awaitStatusCode(
                    org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(waitStatus);
        } else {
            org.mockito.Mockito.when(waitCb.awaitStatusCode(
                    org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.any()))
                    .thenThrow(new com.github.dockerjava.api.exception.DockerClientException("timeout"));
        }

        var logs = org.mockito.Mockito.mock(com.github.dockerjava.api.command.LogContainerCmd.class);
        org.mockito.Mockito.when(docker.logContainerCmd("cid")).thenReturn(logs);
        org.mockito.Mockito.when(logs.withStdOut(true)).thenReturn(logs);
        org.mockito.Mockito.when(logs.withStdErr(true)).thenReturn(logs);
        org.mockito.Mockito.when(logs.exec(org.mockito.ArgumentMatchers.any())).thenAnswer(inv -> {
            com.github.dockerjava.api.async.ResultCallback.Adapter<com.github.dockerjava.api.model.Frame> cb =
                    inv.getArgument(0);
            cb.onStart(() -> { });
            cb.onNext(new com.github.dockerjava.api.model.Frame(
                    com.github.dockerjava.api.model.StreamType.STDOUT,
                    "{\"v\":1}".getBytes(StandardCharsets.UTF_8)));
            cb.onNext(new com.github.dockerjava.api.model.Frame(
                    com.github.dockerjava.api.model.StreamType.STDERR,
                    "journal".getBytes(StandardCharsets.UTF_8)));
            cb.onComplete();
            return cb;
        });

        org.mockito.Mockito.when(docker.removeContainerCmd("cid")).thenReturn(remove);
        org.mockito.Mockito.when(remove.withForce(true)).thenReturn(remove);
        return docker;
    }

    private static com.github.dockerjava.api.command.CreateContainerCmd createCmdReturning(String id) {
        var create = org.mockito.Mockito.mock(com.github.dockerjava.api.command.CreateContainerCmd.class);
        var response = new com.github.dockerjava.api.command.CreateContainerResponse();
        response.setId(id);
        org.mockito.Mockito.when(create.exec()).thenReturn(response);
        return create;
    }

    @Test
    void full_cycle_returns_output_and_exit_then_removes_container() {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        DockerSandbox sandbox = new DockerSandbox(dockerMock(create, remove, 0), 512, 64, 1.0);

        DockerSandbox.ContainerRun run = sandbox.run("img", Map.of("job.json", "{}"), 5000);

        assertThat(run.stdout()).isEqualTo("{\"v\":1}");
        assertThat(run.stderr()).isEqualTo("journal");
        assertThat(run.exitCode()).isZero();
        // État OOMKilled illisible (non simulé ici) : faux, sans faire échouer la notation.
        assertThat(run.oomKilled()).isFalse();
        org.mockito.Mockito.verify(remove).exec(); // conteneur détruit, succès ou non
        // Étiquette EXACTE des runners : le balayage des orphelins (OrphanSweeper) la cherche
        // avec la valeur « 1 ».
        org.mockito.Mockito.verify(create).withLabels(Map.of(DockerSandbox.RUNNER_LABEL, "1"));
    }

    @Test
    void oom_killed_state_is_read_before_removal() {
        // S3 (#116) : State.OOMKilled est lu AVANT la suppression du conteneur. Seul, il ne dit
        // rien (vrai dès qu'un processus quelconque a été tué) ; avec la sortie 137, il désigne
        // le superviseur.
        for (int exit : new int[] {0, 137, -1}) {
            boolean oom = exit != -1;   // -1 : état lu, OOMKilled faux
            if (exit == -1) {
                exit = 137;
            }
            var create = createCmdReturning("cid");
            var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
            var docker = dockerMock(create, remove, exit);
            var inspect = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InspectContainerCmd.class);
            var response = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InspectContainerResponse.class);
            var state = org.mockito.Mockito.mock(
                    com.github.dockerjava.api.command.InspectContainerResponse.ContainerState.class);
            org.mockito.Mockito.when(docker.inspectContainerCmd("cid")).thenReturn(inspect);
            org.mockito.Mockito.when(inspect.exec()).thenReturn(response);
            org.mockito.Mockito.when(response.getState()).thenReturn(state);
            org.mockito.Mockito.when(state.getOOMKilled()).thenReturn(oom);

            DockerSandbox.ContainerRun run = new DockerSandbox(docker, 512, 64, 1.0)
                    .run("img", Map.of("job.json", "{}"), 5000);

            assertThat(run.oomKilled()).isEqualTo(oom);
            assertThat(run.supervisorOomKilled()).isEqualTo(oom && exit == 137);
            var order = org.mockito.Mockito.inOrder(inspect, remove);
            order.verify(inspect).exec();
            order.verify(remove).exec();
        }
    }

    @Test
    void missing_image_actionable_message() {
        var create = org.mockito.Mockito.mock(com.github.dockerjava.api.command.CreateContainerCmd.class);
        org.mockito.Mockito.when(create.withHostConfig(org.mockito.ArgumentMatchers.any())).thenReturn(create);
        org.mockito.Mockito.when(create.withLabels(org.mockito.ArgumentMatchers.<java.util.Map<String, String>>any())).thenReturn(create);
        org.mockito.Mockito.when(create.exec())
                .thenThrow(new com.github.dockerjava.api.exception.NotFoundException("no such image"));
        var docker = org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        org.mockito.Mockito.when(docker.createContainerCmd("img")).thenReturn(create);

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> new DockerSandbox(docker, 512, 64, 1.0).run("img", Map.of(), 1000))
                .isInstanceOf(SandboxException.class)
                .hasMessageContaining("Image runner absente");
    }

    @Test
    void time_budget_exceeded_throws_sandbox_exception_and_removes_container() {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, null);
        var inspect = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InspectContainerCmd.class);
        var response = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InspectContainerResponse.class);
        var state = org.mockito.Mockito.mock(
                com.github.dockerjava.api.command.InspectContainerResponse.ContainerState.class);
        org.mockito.Mockito.when(docker.inspectContainerCmd("cid")).thenReturn(inspect);
        org.mockito.Mockito.when(inspect.exec()).thenReturn(response);
        org.mockito.Mockito.when(response.getState()).thenReturn(state);
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);

        // Mur atteint (ici : mur de 0 ms, donc écoulé) et conteneur ENCORE en marche selon le
        // démon : il a tourné jusqu'au mur sans verdict — cause comptée par core (S4).
        org.mockito.Mockito.when(state.getRunning()).thenReturn(true);
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 0))
                .isInstanceOf(NoVerdictException.class)
                .hasMessageContaining("Mur du conteneur");
        // État absent : rien ne prouve qu'il est arrêté, même conclusion.
        org.mockito.Mockito.when(response.getState()).thenReturn(null);
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 0))
                .isInstanceOf(NoVerdictException.class);
        // Mur atteint mais conteneur ARRÊTÉ : le démon n'a jamais notifié la fin. Sa sortie est
        // lue comme d'habitude, avec le code de sortie de l'inspection.
        org.mockito.Mockito.when(response.getState()).thenReturn(state);
        org.mockito.Mockito.when(state.getRunning()).thenReturn(false);
        org.mockito.Mockito.when(state.getExitCodeLong()).thenReturn(3L);
        DockerSandbox.ContainerRun stopped = sandbox.run("img", Map.of("job.json", "{}"), 0);
        assertThat(stopped.stdout()).isEqualTo("{\"v\":1}");
        assertThat(stopped.exitCode()).isEqualTo(3);
        org.mockito.Mockito.when(state.getExitCodeLong()).thenReturn(null);
        assertThat(sandbox.run("img", Map.of("job.json", "{}"), 0).exitCode()).isEqualTo(-1);
        // État illisible au mur : panne du démon, jamais « sans verdict ».
        org.mockito.Mockito.when(inspect.exec()).thenThrow(new RuntimeException("démon muet"));
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 0))
                .isInstanceOf(SandboxException.class)
                .isNotInstanceOf(NoVerdictException.class)
                .hasMessageContaining("inspection en échec")
                .satisfies(e -> assertThat(e.getCause().getSuppressed()).hasSize(1));
        // Même exception AVANT le mur (flux d'attente coupé : démon redémarré, connexion
        // perdue) : panne, jamais « sans verdict ».
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 60_000))
                .isInstanceOf(SandboxException.class)
                .isNotInstanceOf(NoVerdictException.class)
                .hasMessageContaining("coupée");
        org.mockito.Mockito.verify(remove, org.mockito.Mockito.times(6)).exec();
    }

    @Test
    void shutdown_during_wait_is_unavailable_not_no_verdict() {
        // removeInFlight supprime le conteneur pendant l'attente : la sortie vide passerait pour
        // un superviseur muet, et l'arrêt du service coûterait un échec « sans verdict ».
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);
        var waitCb = docker.waitContainerCmd("cid").start();
        org.mockito.Mockito.when(waitCb.awaitStatusCode(
                        org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.any()))
                .thenAnswer(inv -> {
                    sandbox.removeInFlight();
                    return 137;
                });

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 5000))
                .isInstanceOf(SandboxException.class)
                .isNotInstanceOf(NoVerdictException.class)
                .hasMessageContaining("arrêt");
    }

    @Test
    void shutdown_during_log_read_is_unavailable_not_no_verdict() {
        // Revue #246 : `closed` n'était plus relu après la lecture des journaux ; un arrêt
        // pendant celle-ci rendait une sortie tronquée, comptée « sans verdict ».
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);
        var logs = docker.logContainerCmd("cid");
        org.mockito.Mockito.doAnswer(inv -> {
            com.github.dockerjava.api.async.ResultCallback.Adapter<com.github.dockerjava.api.model.Frame> cb =
                    inv.getArgument(0);
            cb.onStart(() -> { });
            sandbox.removeInFlight();
            cb.onComplete();
            return cb;
        }).when(logs).exec(org.mockito.ArgumentMatchers.any());

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 5000))
                .isInstanceOf(SandboxException.class)
                .isNotInstanceOf(NoVerdictException.class)
                .hasMessageContaining("journaux de notation interrompus");
    }

    @Test
    void wait_callback_closed_and_json_file_log_driver_imposed() throws IOException {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        var waitCb = docker.waitContainerCmd("cid").start();

        new DockerSandbox(docker, 512, 64, 1.0).run("img", Map.of("job.json", "{}"), 5000);

        // Rappel d'attente fermé : sinon sa connexion au démon restait ouverte.
        org.mockito.Mockito.verify(waitCb).close();
        // Pilote de journaux imposé : le verdict est lu par `docker logs`.
        var hostConfig = org.mockito.ArgumentCaptor.forClass(
                com.github.dockerjava.api.model.HostConfig.class);
        org.mockito.Mockito.verify(create).withHostConfig(hostConfig.capture());
        assertThat(hostConfig.getValue().getLogConfig().getType())
                .isEqualTo(com.github.dockerjava.api.model.LogConfig.LoggingType.JSON_FILE);
    }

    @Test
    void interrupted_wait_restores_interrupt_flag() {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        var waitCb = docker.waitContainerCmd("cid").start();
        // Ce que fait docker-java 3.4.1 : l'InterruptedException enveloppée, drapeau non rétabli.
        org.mockito.Mockito.doThrow(new com.github.dockerjava.api.exception.DockerClientException(
                        "Awaiting status code interrupted: ", new InterruptedException()))
                .when(waitCb).awaitStatusCode(
                        org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.any());
        try {
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> new DockerSandbox(docker, 512, 64, 1.0)
                                    .run("img", Map.of("job.json", "{}"), 5000))
                    .isInstanceOf(SandboxException.class)
                    .hasMessageContaining("interrompue");
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();   // ne pas laisser le drapeau aux tests suivants
        }
        org.mockito.Mockito.verify(remove).exec();
    }

    @Test
    void container_removed_with_interrupt_flag_cleared_then_restored() {
        // Sur un fil interrompu, l'appel réel au démon échoue aussitôt (canal du socket fermé) :
        // le conteneur survivait à l'arrêt du service. Vérifier que `exec()` est appelé ne
        // suffisait pas — il faut qu'il le soit SANS le drapeau, puis que le drapeau revienne.
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        var flagDuringRemove = new java.util.concurrent.atomic.AtomicReference<Boolean>();
        org.mockito.Mockito.doAnswer(inv -> {
            flagDuringRemove.set(Thread.currentThread().isInterrupted());
            return null;
        }).when(remove).exec();
        var waitCb = docker.waitContainerCmd("cid").start();
        org.mockito.Mockito.doThrow(new com.github.dockerjava.api.exception.DockerClientException(
                        "Awaiting status code interrupted: ", new InterruptedException()))
                .when(waitCb).awaitStatusCode(
                        org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.any());
        try {
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> new DockerSandbox(docker, 512, 64, 1.0)
                                    .run("img", Map.of("job.json", "{}"), 5000))
                    .isInstanceOf(SandboxException.class);
            assertThat(flagDuringRemove.get()).as("drapeau pendant la suppression").isFalse();
            assertThat(Thread.currentThread().isInterrupted()).as("drapeau rétabli").isTrue();
        } finally {
            Thread.interrupted();   // ne pas laisser le drapeau aux tests suivants
        }
    }

    @Test
    void incomplete_log_read_fails_instead_of_returning_truncated_output() {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        // Journaux jamais terminés : ni onComplete ni onError.
        var logs = docker.logContainerCmd("cid");
        org.mockito.Mockito.doAnswer(inv -> inv.getArgument(0))
                .when(logs).exec(org.mockito.ArgumentMatchers.any());
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);
        sandbox.logReadTimeout = java.time.Duration.ofMillis(200);

        org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(java.time.Duration.ofSeconds(10), () ->
                org.assertj.core.api.Assertions.assertThatThrownBy(
                                () -> sandbox.run("img", Map.of("job.json", "{}"), 5000))
                        .isInstanceOf(SandboxException.class)
                        .hasMessageContaining("Journaux"));
        org.mockito.Mockito.verify(remove).exec();
    }

    @Test
    void cleanup_failure_does_not_swallow_result() {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        org.mockito.Mockito.when(remove.exec()).thenThrow(new RuntimeException("démon occupé"));
        DockerSandbox sandbox = new DockerSandbox(dockerMock(create, remove, 0), 512, 64, 1.0);

        assertThat(sandbox.run("img", Map.of("job.json", "{}"), 5000).exitCode()).isZero();
    }

    @Test
    void orphan_containers_swept_by_the_periodic_sweep() {
        // Si la JVM meurt pendant une notation, le nettoyage du finally n'a pas lieu : les
        // conteneurs survivants portent l'étiquette moodit.runner et sont balayés par
        // OrphanSweeper — dès le démarrage, puis périodiquement (app.sandbox.orphan-sweep-ms).
        com.github.dockerjava.api.DockerClient docker =
                org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        var list = org.mockito.Mockito.mock(
                com.github.dockerjava.api.command.ListContainersCmd.class);
        var remove = org.mockito.Mockito.mock(
                com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var orphan = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Container.class);
        org.mockito.Mockito.when(orphan.getId()).thenReturn("vieux");
        org.mockito.Mockito.when(orphan.getCreated()).thenReturn(
                (System.currentTimeMillis() - DockerSandbox.ORPHAN_GRACE_MS - 60_000) / 1000);
        org.mockito.Mockito.when(docker.listContainersCmd()).thenReturn(list);
        org.mockito.Mockito.when(list.withShowAll(true)).thenReturn(list);
        org.mockito.Mockito.when(list.withLabelFilter(
                org.mockito.ArgumentMatchers.<Map<String, String>>any())).thenReturn(list);
        // Tous les statuts, « running » compris : c'est l'âge (removable) qui protège une
        // notation en vol d'une autre instance sur le même démon.
        org.mockito.Mockito.when(list.withStatusFilter(
                org.mockito.ArgumentMatchers.<java.util.Collection<String>>any())).thenReturn(list);
        org.mockito.Mockito.when(list.exec()).thenReturn(java.util.List.of(orphan));
        org.mockito.Mockito.when(docker.removeContainerCmd("vieux")).thenReturn(remove);
        org.mockito.Mockito.when(remove.withForce(true)).thenReturn(remove);

        assertThat(new DockerSandbox(docker, 512, 64, 1.0).removeOrphans()).isEqualTo(1);
        org.mockito.Mockito.verify(remove).exec();
        // Le filtre lui-même : « running » compris (JVM morte pendant l'exécution), rien d'autre.
        @SuppressWarnings("unchecked")
        org.mockito.ArgumentCaptor<java.util.Collection<String>> statuses =
                org.mockito.ArgumentCaptor.forClass(java.util.Collection.class);
        org.mockito.Mockito.verify(list).withStatusFilter(statuses.capture());
        assertThat(statuses.getValue()).containsExactlyInAnyOrder("created", "running", "exited", "dead");
        // Et l'étiquette des runners : sans elle, le balayage viserait tout conteneur arrêté.
        org.mockito.Mockito.verify(list).withLabelFilter(
                org.mockito.ArgumentMatchers.<Map<String, String>>argThat(
                        m -> Map.of(DockerSandbox.RUNNER_LABEL, "1").equals(m)));
    }

    @Test
    void orphan_sweep_skips_recent_containers_and_survives_a_failed_removal() {
        // Un conteneur récent (notation peut-être en cours) n'est pas touché ; un échec de
        // suppression n'arrête pas le balayage des suivants et n'est pas compté.
        com.github.dockerjava.api.DockerClient docker =
                org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        var list = org.mockito.Mockito.mock(com.github.dockerjava.api.command.ListContainersCmd.class);
        org.mockito.Mockito.when(docker.listContainersCmd()).thenReturn(list);
        org.mockito.Mockito.when(list.withShowAll(true)).thenReturn(list);
        org.mockito.Mockito.when(list.withLabelFilter(
                org.mockito.ArgumentMatchers.<Map<String, String>>any())).thenReturn(list);
        org.mockito.Mockito.when(list.withStatusFilter(
                org.mockito.ArgumentMatchers.<java.util.Collection<String>>any())).thenReturn(list);
        long old = (System.currentTimeMillis() - DockerSandbox.ORPHAN_GRACE_MS - 60_000) / 1000;
        long now = System.currentTimeMillis() / 1000;
        var recent = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Container.class);
        org.mockito.Mockito.when(recent.getId()).thenReturn("recent");
        org.mockito.Mockito.when(recent.getCreated()).thenReturn(now);
        var stuck = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Container.class);
        org.mockito.Mockito.when(stuck.getId()).thenReturn("coince");
        org.mockito.Mockito.when(stuck.getCreated()).thenReturn(old);
        var orphan = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Container.class);
        org.mockito.Mockito.when(orphan.getId()).thenReturn("vieux");
        org.mockito.Mockito.when(orphan.getCreated()).thenReturn(old);
        org.mockito.Mockito.when(list.exec()).thenReturn(java.util.List.of(recent, stuck, orphan));
        var removeStuck = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        org.mockito.Mockito.when(docker.removeContainerCmd("coince")).thenReturn(removeStuck);
        org.mockito.Mockito.when(removeStuck.withForce(true)).thenReturn(removeStuck);
        org.mockito.Mockito.when(removeStuck.exec()).thenThrow(new RuntimeException("démon occupé"));
        var removeOrphan = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        org.mockito.Mockito.when(docker.removeContainerCmd("vieux")).thenReturn(removeOrphan);
        org.mockito.Mockito.when(removeOrphan.withForce(true)).thenReturn(removeOrphan);

        assertThat(new DockerSandbox(docker, 512, 64, 1.0).removeOrphans()).isEqualTo(1);
        org.mockito.Mockito.verify(docker, org.mockito.Mockito.never()).removeContainerCmd("recent");
        org.mockito.Mockito.verify(removeOrphan).exec();
    }

    @Test
    void interruption_while_reading_logs_is_unavailable_and_keeps_the_flag() {
        // Arrêt du service pendant la lecture des journaux : l'attente lève InterruptedException.
        // Panne (jamais « sans verdict »), drapeau d'interruption rétabli, conteneur supprimé.
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        var logs = docker.logContainerCmd("cid");
        org.mockito.Mockito.doAnswer(inv -> {
            com.github.dockerjava.api.async.ResultCallback.Adapter<com.github.dockerjava.api.model.Frame> cb =
                    inv.getArgument(0);
            cb.onStart(() -> { });
            Thread.currentThread().interrupt();
            return cb;
        }).when(logs).exec(org.mockito.ArgumentMatchers.any());

        try {
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> new DockerSandbox(docker, 512, 64, 1.0)
                            .run("img", Map.of("job.json", "{}"), 5000))
                    .isInstanceOf(SandboxException.class)
                    .isNotInstanceOf(NoVerdictException.class)
                    .hasMessageContaining("interrompue")
                    .hasCauseInstanceOf(InterruptedException.class);
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
        org.mockito.Mockito.verify(remove).exec();
    }

    @Test
    void runner_container_swept_only_after_grace_period() {
        // Récent, il appartient peut-être à une notation en cours : « created » (fenêtre
        // create → start d'une autre instance) comme TERMINÉ (fenêtre fin → lecture des
        // journaux). Le balayer faisait échouer cette notation : 502, tentative supprimée.
        long now = System.currentTimeMillis() / 1000;
        long old = (System.currentTimeMillis() - DockerSandbox.ORPHAN_GRACE_MS - 1000) / 1000;
        for (String status : new String[] {"created", "Created", "running", "exited", "dead", null}) {
            assertThat(DockerSandbox.removable(container(status, now))).as(status).isFalse();
            assertThat(DockerSandbox.removable(container(status, old))).as(status).isTrue();
        }
        // Date absente (champ non rempli par le démon) : on s'abstient.
        assertThat(DockerSandbox.removable(container("exited", 0))).isFalse();
        // Borne exacte : supprimable à ORPHAN_GRACE_MS pile, pas une milliseconde avant.
        long created = 1_700_000_000L;
        assertThat(DockerSandbox.removable(container("exited", created),
                created * 1000L + DockerSandbox.ORPHAN_GRACE_MS)).isTrue();
        assertThat(DockerSandbox.removable(container("exited", created),
                created * 1000L + DockerSandbox.ORPHAN_GRACE_MS - 1)).isFalse();
        // Le délai couvre la plus longue vie possible d'un conteneur, comptée depuis sa date de
        // création chez le démon. Lus sur les vraies valeurs, pas recopiés : relever le mur, la
        // lecture des journaux ou un délai du démon sans relever ce délai fait échouer ce test.
        // Appels bornés par RESPONSE_TIMEOUT après la création (DockerSandbox.run) : réponse du
        // create, copie, start, puis, au mur, exitCodeIfStopped et oomKilled. Le /wait n'a pas
        // de délai de réponse (il est borné par le mur). Établissements de connexion après la
        // création : copie, start, wait, deux inspections, journaux.
        int responseBoundedCalls = 5;
        int connections = 6;
        long logReadMs = new DockerSandbox(
                org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class), 512, 64, 1.0)
                .logReadTimeout.toMillis();
        assertThat(DockerSandbox.ORPHAN_GRACE_MS)
                .isGreaterThan(DockerEvaluator.MAX_WALL_MS + logReadMs
                        + responseBoundedCalls * DockerSandbox.RESPONSE_TIMEOUT.toMillis()
                        + connections * DockerSandbox.CONNECTION_TIMEOUT.toMillis());
    }

    private static com.github.dockerjava.api.model.Container container(String state, long createdSeconds) {
        var container = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Container.class);
        org.mockito.Mockito.when(container.getState()).thenReturn(state);
        org.mockito.Mockito.when(container.getCreated()).thenReturn(createdSeconds);
        return container;
    }

    @Test
    void sweep_is_silent_when_daemon_unreachable() {
        // Un démon absent ne doit pas empêcher le service de démarrer.
        assertThat(new DockerSandbox("tcp://localhost:1", 512, 64, 1.0).removeOrphans()).isZero();
    }

    // ── Démon MUET (connexion acceptée, aucune réponse) : faux démon HTTP local ──

    /** Faux démon : {@code /wait} répond après {@code waitDelayMs}, le reste selon {@code mute}. */
    private static com.sun.net.httpserver.HttpServer fakeDaemon(boolean mute, long waitDelayMs)
            throws IOException {
        var server = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(task -> {
            Thread thread = new Thread(task, "faux-demon-docker");
            thread.setDaemon(true);   // les gestionnaires muets dorment encore après stop()
            return thread;
        }));
        server.createContext("/", exchange -> {
            try (exchange) {
                String method = exchange.getRequestMethod();
                String path = exchange.getRequestURI().getPath();
                if (mute) {
                    Thread.sleep(30_000);
                    return;
                }
                if (path.endsWith("/containers/create")) {
                    reply(exchange, 201, "{\"Id\":\"cid\",\"Warnings\":[]}");
                } else if (path.endsWith("/archive")) {
                    reply(exchange, 200, "");
                } else if (path.endsWith("/start")) {
                    exchange.sendResponseHeaders(204, -1);
                } else if (path.endsWith("/wait")) {
                    // Comme dockerd : en-têtes envoyés tout de suite, corps à la fin du conteneur.
                    exchange.getResponseHeaders().add("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, 0);
                    exchange.getResponseBody().flush();
                    Thread.sleep(waitDelayMs);
                    exchange.getResponseBody().write("{\"StatusCode\":0}\n".getBytes(StandardCharsets.UTF_8));
                } else if (path.endsWith("/logs")) {
                    exchange.getResponseHeaders().add("Content-Type", "application/vnd.docker.raw-stream");
                    exchange.sendResponseHeaders(200, -1);
                } else if ("DELETE".equals(method)) {
                    exchange.sendResponseHeaders(204, -1);
                } else {
                    reply(exchange, 404, "{}");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        server.start();
        return server;
    }

    private static void reply(com.sun.net.httpserver.HttpExchange exchange, int status, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) {
            exchange.getResponseBody().write(bytes);
        }
    }

    private static String tcp(com.sun.net.httpserver.HttpServer server) {
        return "tcp://127.0.0.1:" + server.getAddress().getPort();
    }

    @Test
    void mute_daemon_times_out_instead_of_blocking() throws IOException {
        // Sans délai de réponse, chacun de ces appels bloquait indéfiniment (et une notation
        // gardait sa place du sémaphore du sandbox jusqu'au redémarrage du service).
        var server = fakeDaemon(true, 0);
        try {
            DockerSandbox sandbox = new DockerSandbox(tcp(server), 512, 64, 1.0, java.time.Duration.ofMillis(300));
            org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(java.time.Duration.ofSeconds(10), () -> {
                assertThat(sandbox.available()).isFalse();
                assertThat(sandbox.removeOrphans()).isZero();
                org.assertj.core.api.Assertions.assertThatThrownBy(
                                () -> sandbox.run("img", Map.of("job.json", "{}"), 60_000))
                        .isInstanceOf(SandboxException.class);
            });
        } finally {
            server.stop(0);
        }
        // Valeurs de prod : bornées, et assez larges pour un démon simplement chargé.
        assertThat(DockerSandbox.CONNECTION_TIMEOUT).isEqualTo(java.time.Duration.ofSeconds(5));
        assertThat(DockerSandbox.RESPONSE_TIMEOUT).isEqualTo(java.time.Duration.ofSeconds(60));
    }

    @Test
    void wait_is_not_cut_by_response_timeout() throws IOException {
        // /wait reste muet jusqu'à la fin du conteneur, bien au-delà du délai de réponse : il
        // passe par un client sans délai de réponse, borné par le mur seul.
        var server = fakeDaemon(false, 1500);
        try {
            DockerSandbox sandbox = new DockerSandbox(tcp(server), 512, 64, 1.0, java.time.Duration.ofMillis(300));
            org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(java.time.Duration.ofSeconds(20), () ->
                    assertThat(sandbox.run("img", Map.of("job.json", "{}"), 10_000).exitCode()).isZero());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void host_config_sets_every_isolation_guarantee() {
        // Le bloc HostConfig PORTE le modèle de menace de #116 : une ligne retirée par un
        // refactoring ou une résolution de conflit ne casse AUCUN autre test (la matrice
        // anti-triche note juste, elle ne tente pas de sortir du conteneur). D'où ces
        // assertions ligne par ligne : réseau, capacités, privilèges, bornes, tmpfs, montages.
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        DockerSandbox sandbox = new DockerSandbox(dockerMock(create, remove, 0), 1024, 512, 2.0);

        // Assertion de VIVACITÉ : sans un run complet, les assertions ci-dessous porteraient
        // sur un HostConfig jamais construit et passeraient toutes.
        assertThat(sandbox.run("img", Map.of("job.json", "{}"), 5000).exitCode()).isZero();

        var captor = org.mockito.ArgumentCaptor.forClass(com.github.dockerjava.api.model.HostConfig.class);
        org.mockito.Mockito.verify(create).withHostConfig(captor.capture());
        com.github.dockerjava.api.model.HostConfig hostConfig = captor.getValue();

        // Réseau COUPÉ : la propriété centrale (ni exfiltration du harnais, ni requête sortante
        // depuis le VPS). Doublée par un cas d'intégration (sortie TCP refusée).
        assertThat(hostConfig.getNetworkMode()).isEqualTo("none");
        // Aucun montage hôte : les fichiers du job arrivent par docker cp (docker-outside-of-docker).
        // Ni bind, ni montage déclaratif, ni volumes empruntés à un autre conteneur.
        assertThat(hostConfig.getBinds()).isNullOrEmpty();
        assertThat(hostConfig.getMounts()).isNullOrEmpty();
        assertThat(hostConfig.getVolumesFrom()).isNullOrEmpty();
        // Aucun périphérique de l'hôte exposé.
        assertThat(hostConfig.getDevices()).isNullOrEmpty();
        // Jamais privilégié (toutes les capacités, tous les périphériques, seccomp et AppArmor
        // levés : le cap-drop ci-dessous ne vaudrait plus rien).
        assertThat(hostConfig.getPrivileged()).isNotEqualTo(Boolean.TRUE);
        // Espaces de noms PRIVÉS (défaut du démon) : partager le PID, l'IPC ou l'espace
        // utilisateur de l'hôte ou d'un autre conteneur (« host », « container:… ») ouvrirait
        // ses processus, sa mémoire partagée ou ses UID au code soumis.
        assertThat(hostConfig.getPidMode()).isNull();
        assertThat(hostConfig.getIpcMode()).isNull();
        assertThat(hostConfig.getUsernsMode()).isNull();

        // Capacités : tout retiré, puis le strict nécessaire au superviseur root.
        assertThat(hostConfig.getCapDrop()).containsExactly(com.github.dockerjava.api.model.Capability.ALL);
        assertThat(hostConfig.getCapAdd()).containsExactlyInAnyOrder(
                com.github.dockerjava.api.model.Capability.CHOWN,
                com.github.dockerjava.api.model.Capability.FOWNER,
                com.github.dockerjava.api.model.Capability.DAC_OVERRIDE,
                com.github.dockerjava.api.model.Capability.SETUID,
                com.github.dockerjava.api.model.Capability.SETGID,
                com.github.dockerjava.api.model.Capability.KILL,
                // Plancher oom_score_adj relevé : le code soumis ne peut plus redescendre son
                // 1000 au niveau du superviseur (cf. mark_oom_victim, supervisor.py).
                com.github.dockerjava.api.model.Capability.SYS_RESOURCE);
        // Superviseur (PID 1) jamais tué par l'OOM : sinon conteneur mort sans JSON, 502 « sans
        // verdict » (compté et plafonné par core, cf. S4). Doublé par un cas d'intégration (RunnerSandboxIntegrationTest).
        assertThat(hostConfig.getOomScoreAdj()).isEqualTo(-1000);
        // SYS_PTRACE n'est PLUS accordée : elle servait à tracer le code soumis pour détecter une
        // lecture du harnais, et le harnais n'entre plus dans rien qu'il puisse atteindre. Un
        // conteneur qui n'a pas cette capacité ne peut tracer aucun processus, point.
        assertThat(hostConfig.getCapAdd())
                .doesNotContain(com.github.dockerjava.api.model.Capability.SYS_PTRACE);
        // Pas d'élévation de privilège possible depuis l'UID étudiant (setuid, fscaps).
        assertThat(hostConfig.getSecurityOpts()).containsExactly("no-new-privileges");

        // Bornes : mémoire SANS swap (sinon la limite mémoire ne borne plus rien), PID, CPU.
        assertThat(hostConfig.getMemory()).isEqualTo(1024L * 1024 * 1024);
        assertThat(hostConfig.getMemorySwap()).isEqualTo(hostConfig.getMemory());
        assertThat(hostConfig.getPidsLimit()).isEqualTo(512L);
        assertThat(hostConfig.getNanoCPUs()).isEqualTo(2_000_000_000L);

        // Les trois SEULS points d'écriture de l'UID étudiant : bornés, nosuid, et noexec
        // partout sauf /box (qui porte les binaires de test compilés).
        assertThat(hostConfig.getTmpFs())
                .containsOnlyKeys("/box", "/tmp", "/dev/shm")
                // nr_inodes : `size=` ne borne que les octets, pas le NOMBRE de fichiers, dont
                // chacun coûte de la mémoire noyau comptée dans le cgroup.
                .containsEntry("/box", "rw,nosuid,exec,size=614m,nr_inodes=32768")
                .containsEntry("/tmp", "rw,nosuid,noexec,size=61m,nr_inodes=4096")
                .containsEntry("/dev/shm", "rw,nosuid,noexec,size=20m,nr_inodes=1024");

        // IPC System V : mémoire du cgroup HORS des tmpfs, qui survit à son créateur. Segments
        // détruits dès qu'ils ne sont plus attachés, aucune file de messages, aucun jeu de
        // sémaphores (semmni, dernier champ de kernel.sem). Doublé par un cas d'intégration
        // (RunnerSandboxIntegrationTest).
        assertThat(hostConfig.getSysctls()).containsOnly(
                Map.entry("kernel.shm_rmid_forced", "1"),
                Map.entry("kernel.msgmni", "0"),
                Map.entry("kernel.sem", "1 1 1 0"));

        // Journaux : json-file IMPOSÉ avec sa taille. Le démon complète une configuration avec
        // ses propres log-opts pour chaque clé absente : un max-size bas sur l'hôte tronquait le
        // verdict, compté ensuite « sans verdict » contre l'étudiant.
        assertThat(hostConfig.getLogConfig().getType())
                .isEqualTo(com.github.dockerjava.api.model.LogConfig.LoggingType.JSON_FILE);
        // Écriture bloquante : en non-blocking (réglage courant d'un démon), Docker jette des
        // messages quand son tampon est plein, et le verdict relu est troué.
        assertThat(hostConfig.getLogConfig().getConfig()).containsOnly(
                Map.entry("max-size", "128m"), Map.entry("max-file", "1"), Map.entry("mode", "blocking"));
    }

    @Test
    void logs_beyond_the_cap_are_a_failure_not_a_truncated_verdict() {
        // Le superviseur borne ses sorties ; si cette borne régresse, le service ne doit ni
        // accumuler la sortie en mémoire ni lire un JSON coupé comme un verdict.
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        DockerSandbox sandbox = new DockerSandbox(dockerMock(create, remove, 0), 512, 64, 1.0);

        // Le mock écrit 7 octets sur chaque flux : au plafond exact, la sortie passe intacte.
        sandbox.logCapBytes = 7;
        assertThat(sandbox.run("img", Map.of("job.json", "{}"), 5000).stdout()).isEqualTo("{\"v\":1}");

        sandbox.logCapBytes = 6;
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 5000))
                .isInstanceOf(NoVerdictException.class)
                .hasMessageContaining("au-delà de 6 octets");
        // Conteneur détruit dans les deux cas.
        org.mockito.Mockito.verify(remove, org.mockito.Mockito.times(2)).exec();
        assertThat(DockerSandbox.LOG_CAP_BYTES).isEqualTo(16 * 1024 * 1024);
    }

    @Test
    void in_flight_containers_are_removed_at_shutdown() throws Exception {
        // Arrêt du service PENDANT une notation : le `finally` de run() vit dans un fil de
        // requête que la JVM n'attend pas. removeInFlight (méthode de destruction du bean)
        // supprime le conteneur ; après un run terminé, il n'y a plus rien à supprimer.
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        var waitCb = docker.waitContainerCmd("cid").start();
        var started = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        org.mockito.Mockito.when(waitCb.awaitStatusCode(
                        org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.any()))
                .thenAnswer(inv -> {
                    started.countDown();
                    release.await();
                    return 0;
                });
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);

        var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            var pending = pool.submit(() -> sandbox.run("img", Map.of("job.json", "{}"), 5000));
            assertThat(started.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            // Les conteneurs EN VOL de cette instance sont visibles (un test d'intégration n'agit
            // que sur les siens).
            assertThat(sandbox.inFlightContainers()).containsExactly("cid");

            assertThat(sandbox.removeInFlight()).isEqualTo(1);
            org.mockito.Mockito.verify(remove).exec();

            // Démon en erreur : journalisé, l'arrêt continue (0 supprimé).
            org.mockito.Mockito.doThrow(
                            new com.github.dockerjava.api.exception.DockerClientException("démon muet"))
                    .when(remove).exec();
            assertThat(sandbox.removeInFlight()).isZero();
            org.mockito.Mockito.doNothing().when(remove).exec();

            release.countDown();
            // La notation interrompue par l'arrêt est une PANNE (indisponible), jamais un
            // « sans verdict » compté contre l'étudiant (#116, S4).
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> pending.get(10, java.util.concurrent.TimeUnit.SECONDS))
                    .hasCauseInstanceOf(SandboxException.class)
                    .cause().isNotInstanceOf(NoVerdictException.class)
                    .hasMessageContaining("arrêt");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
        // Run terminé : le conteneur n'est plus en vol.
        assertThat(sandbox.inFlightContainers()).isEmpty();
        assertThat(sandbox.removeInFlight()).isZero();
    }

    @Test
    void no_container_survives_a_shutdown_that_races_its_creation() {
        // Arrêt engagé AVANT ou PENDANT la création : removeInFlight a pu copier l'ensemble des
        // conteneurs en vol avant que celui-ci n'y entre. run() le supprime lui-même et échoue
        // (502), sans le démarrer.
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);

        assertThat(sandbox.removeInFlight()).isZero();      // rien en vol : aucun appel au démon
        org.mockito.Mockito.verify(remove, org.mockito.Mockito.never()).exec();

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 5000))
                .isInstanceOf(SandboxException.class)
                .hasMessageContaining("en cours d'arrêt");
        org.mockito.Mockito.verify(remove).exec();
        org.mockito.Mockito.verify(docker, org.mockito.Mockito.never()).startContainerCmd("cid");
        assertThat(sandbox.removeInFlight()).isZero();
    }

    @Test
    void sandbox_beans_remove_in_flight_containers_when_the_context_closes() throws Exception {
        // Dès la FERMETURE du contexte (ContextClosedEvent, publié avant l'arrêt progressif du
        // serveur web), pas seulement à la destruction du bean : celle-ci vient après l'attente
        // des requêtes actives, que le SIGKILL de Docker (10 s) ne laisse pas finir.
        // VRAI contexte Spring, avec un contexte ENFANT : la fermeture de l'enfant remonte au
        // parent et ne doit rien arrêter (removeInFlight est sans retour) ; celle du parent, si.
        DockerSandbox sandbox = org.mockito.Mockito.mock(DockerSandbox.class);
        var parent = new org.springframework.context.annotation.AnnotationConfigApplicationContext();
        parent.registerBean(DockerSandbox.class, () -> sandbox, definition -> definition.setDestroyMethodName(""));
        parent.registerBean("inFlightContainerCleanup",
                org.springframework.context.ApplicationListener.class,
                () -> new SandboxBeans().inFlightContainerCleanup(sandbox, parent));
        parent.refresh();
        var child = new org.springframework.context.annotation.AnnotationConfigApplicationContext();
        child.setParent(parent);
        child.refresh();

        child.close();
        org.mockito.Mockito.verify(sandbox, org.mockito.Mockito.never()).removeInFlight();

        parent.close();
        org.mockito.Mockito.verify(sandbox).removeInFlight();

        // Filet : même suppression à la destruction du bean.
        var bean = SandboxBeans.class.getMethod("dockerSandbox",
                        String.class, long.class, long.class, double.class)
                .getAnnotation(org.springframework.context.annotation.Bean.class);
        assertThat(bean.destroyMethod()).isEqualTo("removeInFlight");
    }

    @Test
    void tmpfs_sizes_derived_from_container_memory() {
        // Un tmpfs est compté dans le cgroup : codées en dur, les trois tailles occupaient
        // jusqu'à 83 % de la mémoire quand SANDBOX_MEMORY_MB est abaissé (1 Go en prod).
        DockerSandbox prod = new DockerSandbox("tcp://localhost:1", 1024, 512, 1.0);
        assertThat(prod.boxSizeMb()).isEqualTo(614);
        assertThat(prod.tmpSizeMb()).isEqualTo(61);
        assertThat(prod.shmSizeMb()).isEqualTo(20);
        assertThat(prod.boxSizeMb() + prod.tmpSizeMb() + prod.shmSizeMb()).isLessThan(1024);

        // Planchers : une mémoire minuscule garde des tmpfs utilisables.
        DockerSandbox tinySandbox = new DockerSandbox("tcp://localhost:1", 128, 64, 1.0);
        assertThat(tinySandbox.boxSizeMb()).isEqualTo(256);
        assertThat(tinySandbox.tmpSizeMb()).isEqualTo(32);
        assertThat(tinySandbox.shmSizeMb()).isEqualTo(16);
    }

    @Test
    void memory_outside_docker_bounds_refused_at_startup() {
        // 0 = « illimité » pour Docker, négatif = 502 à chaque notation : refusé au démarrage.
        for (long memoryMb : new long[] {0, -1, DockerSandbox.MIN_MEMORY_MB - 1}) {
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> new DockerSandbox("tcp://localhost:1", memoryMb, 512, 1.0))
                    .as("mémoire %d", memoryMb)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("SANDBOX_MEMORY_MB")
                    .hasMessageContaining("au moins 6 Mo");
        }
        // Au-delà, la taille en octets déborderait (négative) : message propre à cette borne.
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new DockerSandbox(
                        "tcp://localhost:1", DockerSandbox.MAX_MEMORY_MB + 1, 512, 1.0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("SANDBOX_MEMORY_MB")
                .hasMessageContaining("au plus")
                .hasMessageNotContaining("au moins");
        // Bornes exactes acceptées.
        new DockerSandbox("tcp://localhost:1", DockerSandbox.MIN_MEMORY_MB, 512, 1.0);
        new DockerSandbox("tcp://localhost:1", DockerSandbox.MAX_MEMORY_MB, 512, 1.0);
    }

    @Test
    void pids_limit_below_one_refused_at_startup() {
        // 0 et -1 = « illimité » pour Docker : une bombe de fork n'aurait plus de borne.
        for (long pids : new long[] {0, -1}) {
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> new DockerSandbox("tcp://localhost:1", 512, pids, 1.0))
                    .as("PID %d", pids)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("SANDBOX_PIDS_LIMIT");
        }
        new DockerSandbox("tcp://localhost:1", 512, 1, 1.0);
    }

    @Test
    void cpus_below_the_cfs_floor_refused_at_startup() {
        // Plancher : 0,01 CPU (10 000 000 nanoCPU, quota CFS de 1 ms). 0 = « illimité » pour
        // Docker ; sous 10 000 nanoCPU (1e-5 CPU ; ex. 1e-9), le quota CFS vaut 0 : aucune borne
        // non plus ; entre les deux (ex. 0,005), il passe sous 1 ms et le noyau refuse chaque
        // démarrage (EINVAL, 502 à chaque notation).
        for (double cpus : new double[] {0, -1, 1e-10, 1e-9, 0.005, 0.0099,
                Double.NaN, Double.POSITIVE_INFINITY}) {
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> new DockerSandbox("tcp://localhost:1", 512, 512, cpus))
                    .as("CPU %s", cpus)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("SANDBOX_CPUS")
                    .hasMessageContaining("au moins 0,01");
        }
        // Borne exacte acceptée : 0,01 CPU, soit un quota de 1 ms.
        new DockerSandbox("tcp://localhost:1", 512, 512, 0.01);
    }

    @Test
    void validated_limits_reach_the_host_config() {
        // Les valeurs acceptées sont bien celles imposées au conteneur.
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        new DockerSandbox(dockerMock(create, remove, 0), 6, 1, 0.01)
                .run("img", Map.of("job.json", "{}"), 5000);
        org.mockito.ArgumentCaptor<com.github.dockerjava.api.model.HostConfig> host =
                org.mockito.ArgumentCaptor.forClass(com.github.dockerjava.api.model.HostConfig.class);
        org.mockito.Mockito.verify(create).withHostConfig(host.capture());
        assertThat(host.getValue().getMemory()).isEqualTo(6L * 1024 * 1024);
        assertThat(host.getValue().getPidsLimit()).isEqualTo(1L);
        assertThat(host.getValue().getNanoCPUs()).isEqualTo(DockerSandbox.MIN_NANO_CPUS);
    }

    /** Fait répondre {@code infoCmd} du démon mocké avec {@code ncpu} CPU. */
    private static com.github.dockerjava.api.command.InfoCmd hostCpus(
            com.github.dockerjava.api.DockerClient docker, Integer ncpu) {
        var infoCmd = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InfoCmd.class);
        var info = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Info.class);
        org.mockito.Mockito.when(docker.infoCmd()).thenReturn(infoCmd);
        org.mockito.Mockito.when(infoCmd.exec()).thenReturn(info);
        org.mockito.Mockito.when(info.getNCPU()).thenReturn(ncpu);
        return infoCmd;
    }

    @Test
    void cpus_above_host_cpus_capped_once_at_first_use() {
        // Le démon refuse à la création un NanoCPUs au-delà de ses CPU : SANDBOX_CPUS=2.0 sur
        // un hôte à 1 vCPU donnait un 502 à chaque exécution. Plafonné à 1 CPU, lu UNE fois.
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var docker = dockerMock(create, remove, 0);
        var infoCmd = hostCpus(docker, 1);
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 2.0);

        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(DockerSandbox.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            sandbox.run("img", Map.of("job.json", "{}"), 5000);
            sandbox.run("img", Map.of("job.json", "{}"), 5000);
        } finally {
            logger.detachAppender(appender);
        }
        var host = org.mockito.ArgumentCaptor.forClass(com.github.dockerjava.api.model.HostConfig.class);
        org.mockito.Mockito.verify(create, org.mockito.Mockito.times(2)).withHostConfig(host.capture());
        assertThat(host.getAllValues()).extracting(com.github.dockerjava.api.model.HostConfig::getNanoCPUs)
                .containsExactly(1_000_000_000L, 1_000_000_000L);
        org.mockito.Mockito.verify(infoCmd, org.mockito.Mockito.times(1)).exec();
        // Un seul avertissement de plafonnement pour deux exécutions (les autres WARN viennent
        // de l'état OOMKilled, non simulé par le mock).
        assertThat(appender.list)
                .filteredOn(e -> e.getLevel() == ch.qos.logback.classic.Level.WARN)
                .extracting(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .filteredOn(m -> m.contains("SANDBOX_CPUS"))
                .singleElement().asString().contains("plafonné à 1");
    }

    @Test
    void cpus_within_host_cpus_kept() {
        var docker = org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        hostCpus(docker, 4);
        assertThat(new DockerSandbox(docker, 512, 64, 2.0).effectiveNanoCpus(docker))
                .isEqualTo(2_000_000_000L);
        // Borne exacte : autant de CPU que l'hôte, gardé.
        var exact = org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        hostCpus(exact, 2);
        assertThat(new DockerSandbox(exact, 512, 64, 2.0).effectiveNanoCpus(exact))
                .isEqualTo(2_000_000_000L);
    }

    @Test
    void unreadable_host_cpus_keeps_configured_value_and_retries_after_a_delay() {
        // Lecture en échec (démon muet sur /info) : la valeur configurée est gardée, jamais une
        // absence de borne. L'échec est RETENU CPU_READ_RETRY : sans cela, chaque exécution
        // repayait un délai de réponse complet, hors du miroir de délai de core.
        var docker = org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        var infoCmd = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InfoCmd.class);
        org.mockito.Mockito.when(docker.infoCmd()).thenReturn(infoCmd);
        org.mockito.Mockito.when(infoCmd.exec()).thenThrow(new RuntimeException("démon muet"));
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 2.0);
        long[] now = {1_000L};
        sandbox.nanoClock = () -> now[0];

        assertThat(sandbox.effectiveNanoCpus(docker)).isEqualTo(2_000_000_000L);
        now[0] += DockerSandbox.CPU_READ_RETRY.toNanos() - 1;   // juste avant l'échéance
        assertThat(sandbox.effectiveNanoCpus(docker)).isEqualTo(2_000_000_000L);
        org.mockito.Mockito.verify(infoCmd, org.mockito.Mockito.times(1)).exec();

        now[0] += 1;   // échéance atteinte : nouvelle tentative, qui réussit cette fois
        var info = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Info.class);
        org.mockito.Mockito.when(info.getNCPU()).thenReturn(1);
        org.mockito.Mockito.doReturn(info).when(infoCmd).exec();
        assertThat(sandbox.effectiveNanoCpus(docker)).isEqualTo(1_000_000_000L);
        org.mockito.Mockito.verify(infoCmd, org.mockito.Mockito.times(2)).exec();

        // Réponse sans NCPU : même règle que l'échec (valeur gardée).
        var noCount = org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        hostCpus(noCount, null);
        assertThat(new DockerSandbox(noCount, 512, 64, 2.0).effectiveNanoCpus(noCount))
                .isEqualTo(2_000_000_000L);
    }

    @Test
    void concurrent_runs_never_wait_on_a_slow_host_cpu_read() throws Exception {
        // /info lent : UNE seule lecture, hors verrou. Une exécution concurrente prend la valeur
        // configurée SANS attendre (sous synchronized, elle payait le délai de l'autre, puis le
        // sien — jusqu'à N × 65 s pour la dernière).
        var docker = org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        var infoCmd = org.mockito.Mockito.mock(com.github.dockerjava.api.command.InfoCmd.class);
        var info = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Info.class);
        org.mockito.Mockito.when(docker.infoCmd()).thenReturn(infoCmd);
        org.mockito.Mockito.when(info.getNCPU()).thenReturn(1);
        java.util.concurrent.CountDownLatch reading = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        org.mockito.Mockito.when(infoCmd.exec()).thenAnswer(inv -> {
            reading.countDown();
            release.await();
            return info;
        });
        DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 2.0);

        var first = java.util.concurrent.CompletableFuture.supplyAsync(
                () -> sandbox.effectiveNanoCpus(docker));
        assertThat(reading.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        // Pendant la lecture : réponse IMMÉDIATE (au plus 5 s, la lecture, elle, ne rend pas),
        // valeur configurée.
        var second = java.util.concurrent.CompletableFuture.supplyAsync(
                () -> sandbox.effectiveNanoCpus(docker));
        assertThat(second.get(5, java.util.concurrent.TimeUnit.SECONDS)).isEqualTo(2_000_000_000L);
        release.countDown();
        assertThat(first.get(10, java.util.concurrent.TimeUnit.SECONDS)).isEqualTo(1_000_000_000L);
        // Lue une fois, puis servie depuis le cache.
        assertThat(sandbox.effectiveNanoCpus(docker)).isEqualTo(1_000_000_000L);
        org.mockito.Mockito.verify(infoCmd, org.mockito.Mockito.times(1)).exec();
    }

    @Test
    void container_vanishing_after_creation_is_not_a_missing_image() {
        // Un 404 APRÈS la création vise le conteneur (supprimé en vol), pas l'image : « Image
        // runner absente » envoyait chercher une image qui était bien là.
        for (boolean shutdown : new boolean[] {false, true}) {
            var create = createCmdReturning("cid");
            var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
            var docker = dockerMock(create, remove, 0);
            DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);
            var start = docker.startContainerCmd("cid");
            org.mockito.Mockito.when(start.exec()).thenAnswer(inv -> {
                if (shutdown) {
                    sandbox.removeInFlight();
                }
                throw new com.github.dockerjava.api.exception.NotFoundException("no such container");
            });
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> sandbox.run("img", Map.of("job.json", "{}"), 5000))
                    .as("arrêt %s", shutdown)
                    .isInstanceOf(SandboxException.class)
                    .isNotInstanceOf(NoVerdictException.class)
                    .hasMessageNotContaining("Image runner absente")
                    .hasMessageContaining(shutdown ? "Service en cours d'arrêt" : "disparu");
        }
    }

    @Test
    void not_found_during_copy_names_a_non_runner_image() {
        // 404 PENDANT LA COPIE : /opt/moodit manque dans l'image (préfixe ou étiquette qui
        // désigne une image non runner) — ni « conteneur disparu », ni « image absente ». Sous
        // l'arrêt du service, c'est l'arrêt qui est nommé. Toujours une panne (« indisponible »),
        // jamais « sans verdict ».
        for (boolean shutdown : new boolean[] {false, true}) {
            var create = createCmdReturning("cid");
            var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
            var docker = dockerMock(create, remove, 0);
            DockerSandbox sandbox = new DockerSandbox(docker, 512, 64, 1.0);
            var copy = docker.copyArchiveToContainerCmd("cid");
            org.mockito.Mockito.when(copy.exec()).thenAnswer(inv -> {
                if (shutdown) {
                    sandbox.removeInFlight();
                }
                throw new com.github.dockerjava.api.exception.NotFoundException("no such path");
            });
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> sandbox.run("img", Map.of("job.json", "{}"), 5000))
                    .as("arrêt %s", shutdown)
                    .isInstanceOf(SandboxException.class)
                    .isNotInstanceOf(NoVerdictException.class)
                    .hasMessageNotContaining("Image runner absente")
                    .hasMessageNotContaining("disparu")
                    .hasMessageContaining(shutdown ? "Service en cours d'arrêt"
                            : "Zone de transit /opt/moodit absente de l'image img");
            org.mockito.Mockito.verify(docker, org.mockito.Mockito.never()).startContainerCmd("cid");
        }
    }
}
