package com.moodit.execution_service.sandbox;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Capability;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.StreamType;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.zerodep.ZerodepDockerHttpClient;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Lance le CONTENEUR RUNNER jetable d'une notation compilée (#116) et en rapporte la sortie JSON
 * du superviseur. Un conteneur par évaluation : réseau coupé, mémoire/PID/CPU bornés,
 * {@code no-new-privileges} ; {@code SYS_PTRACE} ajouté pour que le superviseur trace le processus
 * étudiant (détection des lectures du harnais). Les fichiers du job sont copiés dans le conteneur
 * AVANT son démarrage (pas de montage hôte : compatible docker-outside-of-docker), puis le
 * conteneur est détruit, succès ou non.
 *
 * Toute erreur d'infrastructure (démon Docker injoignable, image absente, budget de temps du
 * conteneur dépassé) devient une {@link SandboxException} → 502, et la correction reste
 * « en cours » côté core (elle sera rejouée).
 */
public class DockerSandbox {

    private static final Logger log = LoggerFactory.getLogger(DockerSandbox.class);

    /** Sortie (stdout = JSON du superviseur) et code de sortie du conteneur. */
    public record ContainerRun(String stdout, String stderr, long exitCode) {}

    private final String dockerHost;
    private final long memoryBytes;
    private final long pidsLimit;
    private final long nanoCpus;
    private volatile DockerClient client;

    public DockerSandbox(String dockerHost, long memoryMb, long pidsLimit, double cpus) {
        this.dockerHost = dockerHost == null || dockerHost.isBlank() ? defaultDockerHost() : dockerHost;
        this.memoryBytes = memoryMb * 1024 * 1024;
        this.pidsLimit = pidsLimit;
        this.nanoCpus = (long) (cpus * 1_000_000_000L);
    }

    /** Pour les tests : client Docker injecté (aucune résolution d'hôte). */
    DockerSandbox(DockerClient client, long memoryMb, long pidsLimit, double cpus) {
        this("tcp://injecte-pour-les-tests", memoryMb, pidsLimit, cpus);
        this.client = client;
    }

    /** Démon local par défaut selon l'OS (dev Windows : npipe ; Linux/conteneur : socket Unix). */
    static String defaultDockerHost() {
        String os = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
        return os.contains("win") ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
    }

    // Initialisation PARESSEUSE : le service doit démarrer même sans démon Docker (seules les
    // notations compilées en dépendent) — même philosophie que Piston injoignable.
    private DockerClient client() {
        DockerClient current = client;
        if (current != null) {
            return current;
        }
        synchronized (this) {
            if (client == null) {
                var config = DefaultDockerClientConfig.createDefaultConfigBuilder()
                        .withDockerHost(dockerHost)
                        .build();
                var http = new ZerodepDockerHttpClient.Builder()
                        .dockerHost(config.getDockerHost())
                        .build();
                client = DockerClientImpl.getInstance(config, http);
            }
            return client;
        }
    }

    /** Le démon répond-il ? (gating des tests d'intégration et messages d'erreur clairs) */
    public boolean available() {
        try {
            client().pingCmd().exec();
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    public boolean imagePresent(String image) {
        try {
            client().inspectImageCmd(image).exec();
            return true;
        } catch (NotFoundException e) {
            return false;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * Crée le conteneur, y copie {@code files} (chemins relatifs à {@code /box}), l'exécute et
     * renvoie sa sortie. {@code wallTimeoutMs} borne la vie TOTALE du conteneur (compilations
     * comprises) : au-delà, il est tué et la notation échoue proprement.
     */
    public ContainerRun run(String image, Map<String, String> files, long wallTimeoutMs) {
        DockerClient docker;
        try {
            docker = client();
        } catch (RuntimeException e) {
            throw new SandboxException("Démon Docker injoignable (" + dockerHost + ")", e);
        }

        String containerId = null;
        try {
            HostConfig hostConfig = HostConfig.newHostConfig()
                    .withNetworkMode("none")
                    .withMemory(memoryBytes)
                    .withMemorySwap(memoryBytes)
                    .withPidsLimit(pidsLimit)
                    .withNanoCPUs(nanoCpus)
                    .withCapAdd(Capability.SYS_PTRACE)
                    .withSecurityOpts(List.of("no-new-privileges"))
                    .withAutoRemove(false);
            CreateContainerResponse created = docker.createContainerCmd(image)
                    .withHostConfig(hostConfig)
                    .exec();
            containerId = created.getId();

            docker.copyArchiveToContainerCmd(containerId)
                    .withTarInputStream(new ByteArrayInputStream(tarOf(files)))
                    .withRemotePath("/")
                    .exec();

            docker.startContainerCmd(containerId).exec();

            Integer status = docker.waitContainerCmd(containerId)
                    .start()
                    .awaitStatusCode(wallTimeoutMs, TimeUnit.MILLISECONDS);

            StringBuilder stdout = new StringBuilder();
            StringBuilder stderr = new StringBuilder();
            docker.logContainerCmd(containerId)
                    .withStdOut(true)
                    .withStdErr(true)
                    .exec(new ResultCallback.Adapter<Frame>() {
                        @Override
                        public void onNext(Frame frame) {
                            String text = new String(frame.getPayload(), StandardCharsets.UTF_8);
                            if (frame.getStreamType() == StreamType.STDOUT) {
                                stdout.append(text);
                            } else {
                                stderr.append(text);
                            }
                        }
                    })
                    .awaitCompletion(30, TimeUnit.SECONDS);
            return new ContainerRun(stdout.toString(), stderr.toString(), status == null ? -1 : status);
        } catch (NotFoundException e) {
            throw new SandboxException("Image runner absente : " + image
                    + " — construire les images (docker/runners/build.sh)", e);
        } catch (SandboxException e) {
            throw e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SandboxException("Notation interrompue", e);
        } catch (RuntimeException | IOException e) {
            throw new SandboxException("Échec du conteneur de notation : " + e.getMessage(), e);
        } finally {
            if (containerId != null) {
                try {
                    docker.removeContainerCmd(containerId).withForce(true).exec();
                } catch (RuntimeException e) {
                    log.warn("Nettoyage du conteneur {} échoué : {}", containerId, e.getMessage());
                }
            }
        }
    }

    /**
     * Tar en mémoire : chaque fichier sous {@code box/}, en 0600 root (le harnais est illisible
     * par l'UID étudiant dès l'extraction), et la sentinelle {@code box/.ready} EN DERNIER —
     * le superviseur ne démarre la notation qu'une fois toute la copie terminée.
     */
    static byte[] tarOf(Map<String, String> files) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(buffer)) {
            tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX);
            for (Map.Entry<String, String> entry : files.entrySet()) {
                writeEntry(tar, "box/" + entry.getKey(), entry.getValue());
            }
            writeEntry(tar, "box/.ready", "ok\n");
        }
        return buffer.toByteArray();
    }

    private static void writeEntry(TarArchiveOutputStream tar, String path, String content)
            throws IOException {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        TarArchiveEntry entry = new TarArchiveEntry(path);
        entry.setSize(bytes.length);
        entry.setMode(0600);
        tar.putArchiveEntry(entry);
        tar.write(bytes);
        tar.closeArchiveEntry();
    }
}
