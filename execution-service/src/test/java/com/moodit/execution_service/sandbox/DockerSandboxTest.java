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
    void tar_places_files_under_box_0600_and_ready_last() throws IOException {
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
        org.mockito.Mockito.verify(remove).exec(); // conteneur détruit, succès ou non
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
        DockerSandbox sandbox = new DockerSandbox(dockerMock(create, remove, null), 512, 64, 1.0);

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> sandbox.run("img", Map.of("job.json", "{}"), 1000))
                .isInstanceOf(SandboxException.class);
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
    void orphan_containers_swept_at_startup() {
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
        org.mockito.Mockito.when(orphan.getCreated()).thenReturn(
                (System.currentTimeMillis() - DockerSandbox.ORPHAN_GRACE_MS - 60_000) / 1000);
        org.mockito.Mockito.when(docker.listContainersCmd()).thenReturn(list);
        org.mockito.Mockito.when(list.withShowAll(true)).thenReturn(list);
        org.mockito.Mockito.when(list.withLabelFilter(
                org.mockito.ArgumentMatchers.<Map<String, String>>any())).thenReturn(list);
        // Seuls les conteneurs TERMINÉS sont balayés : une notation en vol (autre instance
        // sur le même démon) ne doit pas être tuée.
        org.mockito.Mockito.when(list.withStatusFilter(
                org.mockito.ArgumentMatchers.<java.util.Collection<String>>any())).thenReturn(list);
        org.mockito.Mockito.when(list.exec()).thenReturn(java.util.List.of(orphan));
        org.mockito.Mockito.when(docker.removeContainerCmd("vieux")).thenReturn(remove);
        org.mockito.Mockito.when(remove.withForce(true)).thenReturn(remove);

        assertThat(new DockerSandbox(docker, 512, 64, 1.0).removeOrphans()).isEqualTo(1);
        org.mockito.Mockito.verify(remove).exec();
        // Le filtre lui-même : sans « running » (une notation en vol), et sans rien d'autre.
        @SuppressWarnings("unchecked")
        org.mockito.ArgumentCaptor<java.util.Collection<String>> statuses =
                org.mockito.ArgumentCaptor.forClass(java.util.Collection.class);
        org.mockito.Mockito.verify(list).withStatusFilter(statuses.capture());
        assertThat(statuses.getValue()).containsExactlyInAnyOrder("created", "exited", "dead");
        // Et l'étiquette des runners : sans elle, le balayage viserait tout conteneur arrêté.
        org.mockito.Mockito.verify(list).withLabelFilter(
                org.mockito.ArgumentMatchers.<Map<String, String>>argThat(
                        m -> m != null && m.containsKey("moodit.runner")));
    }

    @Test
    void runner_container_swept_only_after_grace_period() {
        // Récent, il appartient peut-être à une notation en cours : « created » (fenêtre
        // create → start d'une autre instance) comme TERMINÉ (fenêtre fin → lecture des
        // journaux). Le balayer faisait échouer cette notation : 502, tentative supprimée.
        long now = System.currentTimeMillis() / 1000;
        long old = (System.currentTimeMillis() - DockerSandbox.ORPHAN_GRACE_MS - 1000) / 1000;
        for (String status : new String[] {"created", "Created", "exited", "dead", null}) {
            assertThat(DockerSandbox.removable(container(status, now))).as(status).isFalse();
            assertThat(DockerSandbox.removable(container(status, old))).as(status).isTrue();
        }
        // Date absente (champ non rempli par le démon) : on s'abstient.
        assertThat(DockerSandbox.removable(container("exited", 0))).isFalse();
        // Le délai couvre le plus long mur possible, journaux compris.
        assertThat(DockerSandbox.ORPHAN_GRACE_MS).isGreaterThan(15 * 60_000L + 30_000L);
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
        assertThat(hostConfig.getBinds()).isNullOrEmpty();

        // Capacités : tout retiré, puis le strict nécessaire au superviseur root.
        assertThat(hostConfig.getCapDrop()).containsExactly(com.github.dockerjava.api.model.Capability.ALL);
        assertThat(hostConfig.getCapAdd()).containsExactlyInAnyOrder(
                com.github.dockerjava.api.model.Capability.CHOWN,
                com.github.dockerjava.api.model.Capability.FOWNER,
                com.github.dockerjava.api.model.Capability.DAC_OVERRIDE,
                com.github.dockerjava.api.model.Capability.SETUID,
                com.github.dockerjava.api.model.Capability.SETGID,
                com.github.dockerjava.api.model.Capability.KILL);
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
                .containsEntry("/box", "rw,nosuid,exec,size=614m")
                .containsEntry("/tmp", "rw,nosuid,noexec,size=61m")
                .containsEntry("/dev/shm", "rw,nosuid,noexec,size=20m");
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
        DockerSandbox lowercase = new DockerSandbox("tcp://localhost:1", 128, 64, 1.0);
        assertThat(lowercase.boxSizeMb()).isEqualTo(256);
        assertThat(lowercase.tmpSizeMb()).isEqualTo(32);
        assertThat(lowercase.shmSizeMb()).isEqualTo(16);
    }
}
