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
 * du superviseur. Un conteneur par évaluation : réseau coupé, écritures étudiantes confinées aux
 * tmpfs bornés {@code /box} et {@code /tmp}, mémoire/PID/CPU bornés, toutes les capacités
 * retirées sauf le minimum du superviseur, {@code no-new-privileges} ; {@code SYS_PTRACE} gardé
 * pour que le superviseur trace le processus étudiant (détection des lectures du harnais). Les
 * fichiers du job sont copiés AVANT le démarrage dans la zone de transit de l'image
 * ({@code /opt/moodit/staging}, 0600 root — {@code docker cp} ne sait pas écrire dans un
 * tmpfs), puis déplacés dans le tmpfs {@code /box} par le superviseur (pas de montage hôte :
 * compatible docker-outside-of-docker) ; le conteneur est détruit à la fin, succès ou non.
 *
 * Toute erreur d'infrastructure (démon Docker injoignable, image absente, budget de temps du
 * conteneur dépassé) devient une {@link SandboxException} → 502 ; côté core, la tentative en
 * attente est alors SUPPRIMÉE (quiz:attempt-failed) et l'étudiant doit resoumettre — il n'existe
 * pas de rejouage automatique, d'où l'attente interne généreuse (EXEC_INTERNAL_QUEUE_WAIT_MS).
 */
public class DockerSandbox {

    private static final Logger log = LoggerFactory.getLogger(DockerSandbox.class);

    /** Sortie (stdout = JSON du superviseur) et code de sortie du conteneur. */
    public record ContainerRun(String stdout, String stderr, long exitCode) {}

    /** Étiquette posée sur tout conteneur runner : permet de retrouver les orphelins. */
    public static final String RUNNER_LABEL = "moodit.runner";

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

    /** Espace de travail du job (sources, artefacts de build) : 60 % de la mémoire, ≥ 256 Mo. */
    long boxSizeMb() {
        return Math.max(256, memoryBytes / (1024 * 1024) * 60 / 100);
    }

    /** {@code /tmp} : exigé en dur par certains outils (hsperfdata de la JVM, mono, sort). */
    long tmpSizeMb() {
        return Math.max(32, memoryBytes / (1024 * 1024) * 6 / 100);
    }

    /** {@code /dev/shm} : monté d'office par Docker, borné ici pour rester dans le cgroup. */
    long shmSizeMb() {
        return Math.max(16, memoryBytes / (1024 * 1024) * 2 / 100);
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

    /**
     * Supprime les conteneurs runner laissés par une instance précédente (JVM tuée pendant une
     * notation : son {@code finally} de nettoyage n'a jamais tourné). Appelé au démarrage du
     * service ; sans effet si le démon est injoignable — ce n'est pas une raison de ne pas
     * démarrer.
     */
    public int removeOrphans() {
        int removed = 0;
        try {
            // Statuts TERMINÉS seulement : plusieurs instances peuvent partager le démon
            // (pile e2e + dev, ou un update.sh pendant une correction). Balayer tout ce qui
            // porte l'étiquette tuait une notation EN VOL — 502, tentative supprimée, soit
            // précisément le mode d'échec que le reste de la PR s'applique à éliminer.
            List<com.github.dockerjava.api.model.Container> orphans = client().listContainersCmd()
                    .withShowAll(true)
                    .withLabelFilter(Map.of(RUNNER_LABEL, "1"))
                    // « created » EXCLU : c'est la fenêtre entre createContainerCmd et
                    // startContainerCmd d'une autre instance — la balayer ferait échouer son
                    // démarrage (502, tentative supprimée).
                    .withStatusFilter(List.of("exited", "dead"))
                    .exec();
            for (com.github.dockerjava.api.model.Container container : orphans) {
                try {
                    client().removeContainerCmd(container.getId()).withForce(true).exec();
                    removed++;
                } catch (RuntimeException e) {
                    log.warn("Conteneur orphelin {} non supprimé : {}", container.getId(), e.getMessage());
                }
            }
            if (removed > 0) {
                log.info("{} conteneur(s) runner orphelin(s) supprimé(s) au démarrage", removed);
            }
        } catch (RuntimeException e) {
            log.debug("Balayage des conteneurs orphelins impossible : {}", e.getMessage());
        }
        return removed;
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
                    // Écritures de l'UID étudiant CONFINÉES aux deux tmpfs bornés ci-dessous
                    // (comptés dans la mémoire du conteneur) : les images verrouillent leurs
                    // répertoires monde-inscriptibles (/var/tmp, /go, cargo… — cf. Dockerfiles),
                    // il ne reste donc que /box et /tmp — le code étudiant ne peut pas remplir le
                    // disque de l'hôte. (`ReadonlyRootfs` ferait pareil en plus strict, mais le
                    // démon refuse alors TOUT `docker cp`, même vers un tmpfs.) /box porte le job
                    // ET les artefacts de compilation (cible cargo, GOCACHE…) donc PAS de noexec ;
                    // /tmp couvre les outils qui l'exigent en dur (JVM hsperfdata, mono, sort…).
                    // Tailles DÉRIVÉES de la mémoire du conteneur : un tmpfs est compté dans
                    // le cgroup, les coder en dur les faisait occuper jusqu'à 83 % de la
                    // mémoire quand SANDBOX_MEMORY_MB est abaissé (1 Go en prod).
                    .withTmpFs(Map.of(
                            // `exec` EXPLICITE : les tmpfs Docker sont noexec par défaut, et les
                            // binaires de test compilés (Go/Rust/C/C++) s'exécutent depuis /box.
                            "/box", "rw,nosuid,exec,size=" + boxSizeMb() + "m",
                            "/tmp", "rw,nosuid,noexec,size=" + tmpSizeMb() + "m",
                            // Docker monte TOUJOURS /dev/shm (tmpfs 1777, 64 Mo par défaut) :
                            // sans cette entrée, il échappait à l'inventaire des points
                            // d'écriture de l'UID étudiant. Borné et noexec comme /tmp.
                            "/dev/shm", "rw,nosuid,noexec,size=" + shmSizeMb() + "m"))
                    // Capacités : on retire TOUT puis on rend le strict nécessaire au superviseur
                    // root — chown/droits sur les fichiers du job (CHOWN, FOWNER, DAC_OVERRIDE),
                    // bascule vers l'UID étudiant (SETUID, SETGID), nettoyage des groupes de
                    // processus (KILL) et traçage strace du processus étudiant (SYS_PTRACE).
                    .withCapDrop(Capability.ALL)
                    .withCapAdd(Capability.CHOWN, Capability.FOWNER, Capability.DAC_OVERRIDE,
                            Capability.SETUID, Capability.SETGID, Capability.KILL,
                            Capability.SYS_PTRACE)
                    .withSecurityOpts(List.of("no-new-privileges"))
                    .withAutoRemove(false);
            CreateContainerResponse created = docker.createContainerCmd(image)
                    .withHostConfig(hostConfig)
                    // Étiquette : seul moyen de RETROUVER ces conteneurs. Si la JVM meurt
                    // pendant une notation (OOM, redémarrage, update.sh), le `finally` de
                    // nettoyage ci-dessous ne s'exécute jamais et le conteneur reste en
                    // « Exited » — `removeOrphans()` les balaie au démarrage du service.
                    .withLabels(Map.of(RUNNER_LABEL, "1"))
                    .exec();
            containerId = created.getId();

            // Copier AVANT le démarrage, dans la ZONE DE TRANSIT de l'image (/opt/moodit/staging,
            // 0600 root) : `docker cp` ne sait pas écrire dans un tmpfs (l'extraction atterrit
            // dans la couche image, masquée par le montage). Au démarrage, le superviseur attend
            // la sentinelle .ready (dernière entrée du tar) puis DÉPLACE le job dans le tmpfs
            // /box, seul endroit où le code étudiant écrit.
            docker.copyArchiveToContainerCmd(containerId)
                    .withTarInputStream(new ByteArrayInputStream(tarOf(files)))
                    .withRemotePath("/opt/moodit")
                    .exec();

            docker.startContainerCmd(containerId).exec();

            Integer status = docker.waitContainerCmd(containerId)
                    .start()
                    .awaitStatusCode(wallTimeoutMs, TimeUnit.MILLISECONDS);

            // Accumuler les OCTETS puis décoder UNE fois : un caractère UTF-8 scindé entre deux
            // frames deviendrait sinon « � » dans le détail d'un verdict.
            ByteArrayOutputStream stdout = new ByteArrayOutputStream();
            ByteArrayOutputStream stderr = new ByteArrayOutputStream();
            docker.logContainerCmd(containerId)
                    .withStdOut(true)
                    .withStdErr(true)
                    .exec(new ResultCallback.Adapter<Frame>() {
                        @Override
                        public void onNext(Frame frame) {
                            byte[] payload = frame.getPayload();
                            if (frame.getStreamType() == StreamType.STDOUT) {
                                stdout.write(payload, 0, payload.length);
                            } else {
                                stderr.write(payload, 0, payload.length);
                            }
                        }
                    })
                    .awaitCompletion(30, TimeUnit.SECONDS);
            return new ContainerRun(stdout.toString(StandardCharsets.UTF_8),
                    stderr.toString(StandardCharsets.UTF_8), status == null ? -1 : status);
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
     * Tar en mémoire, extrait dans {@code /opt/moodit} : chaque fichier sous {@code staging/},
     * en 0600 root (le harnais est illisible par l'UID étudiant dès l'extraction), et la
     * sentinelle {@code staging/.ready} EN DERNIER — le superviseur ne déplace le job vers
     * {@code /box} qu'une fois toute la copie terminée.
     */
    static byte[] tarOf(Map<String, String> files) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(buffer)) {
            tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX);
            for (Map.Entry<String, String> entry : files.entrySet()) {
                writeEntry(tar, "staging/" + entry.getKey(), entry.getValue());
            }
            writeEntry(tar, "staging/.ready", "ok\n");
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
