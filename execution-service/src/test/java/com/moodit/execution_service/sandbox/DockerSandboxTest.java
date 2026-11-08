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

/** Archive tar du job runner (#116) : chemins sous /box, fichiers 0600, sentinelle en dernier. */
class DockerSandboxTest {

    @Test
    void tar_place_les_fichiers_sous_box_en_0600_et_ready_en_dernier() throws IOException {
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
    void hote_docker_par_defaut_selon_l_os() {
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
    void demon_injoignable_available_et_image_present_repondent_false() {
        assertThat(unreachable.available()).isFalse();
        // Second appel : le client déjà initialisé est réutilisé (chemin rapide).
        assertThat(unreachable.available()).isFalse();
        assertThat(unreachable.imagePresent("moodit-runner-go:latest")).isFalse();
    }

    @Test
    void demon_injoignable_run_leve_sandbox_exception() {
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> unreachable.run("moodit-runner-go:latest", Map.of("job.json", "{}"), 1000))
                .isInstanceOf(SandboxException.class);
    }

    @Test
    void hote_docker_invalide_echoue_en_sandbox_exception_au_premier_run() {
        // L'initialisation paresseuse du client échoue (URI invalide) → message « injoignable ».
        DockerSandbox invalid = new DockerSandbox("::pas-une-uri::", 512, 64, 1.0);
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> invalid.run("img", Map.of(), 1000))
                .isInstanceOf(SandboxException.class)
                .hasMessageContaining("injoignable");
    }

    @Test
    void image_present_distingue_absente_de_demon_en_erreur() {
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
    // DockerRunnerIntegrationTest ; ici on vérifie l'orchestration et le nettoyage) ──

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
    void cycle_complet_retourne_sorties_et_exit_puis_detruit_le_conteneur() {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        DockerSandbox sandbox = new DockerSandbox(dockerMock(create, remove, 0), 512, 64, 1.0);

        DockerSandbox.ContainerRun run = sandbox.run("img", Map.of("job.json", "{}"), 5000);

        assertThat(run.stdout()).isEqualTo("{\"v\":1}");
        assertThat(run.stderr()).isEqualTo("journal");
        assertThat(run.exitCode()).isZero();
        org.mockito.Mockito.verify(remove).exec(); // conteneur détruit, succès ou non
    }

    @Test
    void image_absente_message_actionnable() {
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
    void budget_de_temps_depasse_leve_sandbox_exception_et_detruit_le_conteneur() {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        DockerSandbox sandbox = new DockerSandbox(dockerMock(create, remove, null), 512, 64, 1.0);

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 1000))
                .isInstanceOf(SandboxException.class);
        org.mockito.Mockito.verify(remove).exec();
    }

    @Test
    void echec_du_nettoyage_n_avale_pas_le_resultat() {
        var create = createCmdReturning("cid");
        var remove = org.mockito.Mockito.mock(com.github.dockerjava.api.command.RemoveContainerCmd.class);
        org.mockito.Mockito.when(remove.exec()).thenThrow(new RuntimeException("démon occupé"));
        DockerSandbox sandbox = new DockerSandbox(dockerMock(create, remove, 0), 512, 64, 1.0);

        assertThat(sandbox.run("img", Map.of("job.json", "{}"), 5000).exitCode()).isZero();
    }

    @Test
    void balayage_des_conteneurs_orphelins_au_demarrage() {
        // Si la JVM meurt pendant une notation, le nettoyage du finally n'a pas lieu : les
        // conteneurs survivants portent l'étiquette moodit.runner et sont balayés au démarrage.
        com.github.dockerjava.api.DockerClient docker =
                org.mockito.Mockito.mock(com.github.dockerjava.api.DockerClient.class);
        var list = org.mockito.Mockito.mock(
                com.github.dockerjava.api.command.ListContainersCmd.class);
        var remove = org.mockito.Mockito.mock(
                com.github.dockerjava.api.command.RemoveContainerCmd.class);
        var orphan = org.mockito.Mockito.mock(com.github.dockerjava.api.model.Container.class);
        org.mockito.Mockito.when(orphan.getId()).thenReturn("vieux");
        org.mockito.Mockito.when(docker.listContainersCmd()).thenReturn(list);
        org.mockito.Mockito.when(list.withShowAll(true)).thenReturn(list);
        org.mockito.Mockito.when(list.withLabelFilter(
                org.mockito.ArgumentMatchers.<Map<String, String>>any())).thenReturn(list);
        org.mockito.Mockito.when(list.exec()).thenReturn(java.util.List.of(orphan));
        org.mockito.Mockito.when(docker.removeContainerCmd("vieux")).thenReturn(remove);
        org.mockito.Mockito.when(remove.withForce(true)).thenReturn(remove);

        assertThat(new DockerSandbox(docker, 512, 64, 1.0).removeOrphans()).isEqualTo(1);
        org.mockito.Mockito.verify(remove).exec();
    }

    @Test
    void balayage_silencieux_si_le_demon_est_injoignable() {
        // Un démon absent ne doit pas empêcher le service de démarrer.
        assertThat(new DockerSandbox("tcp://localhost:1", 512, 64, 1.0).removeOrphans()).isZero();
    }
}
