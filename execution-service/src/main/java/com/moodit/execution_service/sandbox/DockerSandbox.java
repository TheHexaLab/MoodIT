package com.moodit.execution_service.sandbox;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.command.WaitContainerResultCallback;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Capability;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.LogConfig;
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
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Lance le CONTENEUR RUNNER jetable d'une notation compilée (#116) et en rapporte la sortie JSON
 * du superviseur. Un conteneur par évaluation : réseau coupé, écritures étudiantes confinées aux
 * tmpfs bornés {@code /box} et {@code /tmp}, mémoire/PID/CPU bornés, toutes les capacités
 * retirées sauf le minimum du superviseur, {@code no-new-privileges}. {@code SYS_PTRACE} n'est
 * PLUS accordée : elle servait à tracer le code soumis pour détecter une lecture du harnais, ce
 * qui n'a plus d'objet depuis que le harnais n'entre dans aucun fichier ni processus qu'il puisse
 * atteindre (#116). Les
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

    /** Établissement de la connexion au démon : au-delà, il est tenu pour injoignable. */
    static final Duration CONNECTION_TIMEOUT = Duration.ofSeconds(5);

    /**
     * Silence maximal du démon pendant une réponse (create, copie, start, suppression, liste,
     * inspection, ping). Sans cette borne, un démon qui accepte la connexion sans répondre bloquait
     * le fil indéfiniment, avec sa place du sémaphore du sandbox : trois appels suffisaient à rendre
     * l'exécution indisponible jusqu'au redémarrage du service. Ne s'applique PAS à {@code /wait},
     * silencieux jusqu'à la fin du conteneur (voir {@link #waitClient()}).
     */
    static final Duration RESPONSE_TIMEOUT = Duration.ofSeconds(60);

    private final String dockerHost;
    private final long memoryBytes;
    private final long pidsLimit;
    private final long nanoCpus;
    private final Duration responseTimeout;
    /**
     * Délai de lecture des journaux d'un conteneur terminé (le verdict). Compté dans
     * {@code ORPHAN_GRACE_MS}. Modifiable par les tests seulement.
     */
    Duration logReadTimeout = Duration.ofSeconds(30);
    private volatile DockerClient client;
    private volatile DockerClient waitClient;

    public DockerSandbox(String dockerHost, long memoryMb, long pidsLimit, double cpus) {
        this(dockerHost, memoryMb, pidsLimit, cpus, RESPONSE_TIMEOUT);
    }

    /** Pour les tests : délai de réponse raccourci. */
    DockerSandbox(String dockerHost, long memoryMb, long pidsLimit, double cpus, Duration responseTimeout) {
        this.dockerHost = dockerHost == null || dockerHost.isBlank() ? defaultDockerHost() : dockerHost;
        this.memoryBytes = memoryMb * 1024 * 1024;
        this.pidsLimit = pidsLimit;
        this.nanoCpus = (long) (cpus * 1_000_000_000L);
        this.responseTimeout = responseTimeout;
    }

    /** Pour les tests : client Docker injecté (aucune résolution d'hôte). */
    DockerSandbox(DockerClient client, long memoryMb, long pidsLimit, double cpus) {
        this("tcp://injecte-pour-les-tests", memoryMb, pidsLimit, cpus);
        this.client = client;
        this.waitClient = client;
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
                client = newClient(responseTimeout);
            }
            return client;
        }
    }

    /**
     * Client réservé à {@code /wait} : le démon n'y écrit RIEN avant la fin du conteneur (jusqu'à
     * {@code DockerEvaluator.MAX_WALL_MS}), un délai de réponse le couperait. L'attente est bornée
     * côté appelant par {@code awaitStatusCode(wall)}, puis le {@code finally} de {@link #run}
     * détruit le conteneur, ce qui ferme le flux.
     */
    private DockerClient waitClient() {
        DockerClient current = waitClient;
        if (current != null) {
            return current;
        }
        synchronized (this) {
            if (waitClient == null) {
                waitClient = newClient(null);
            }
            return waitClient;
        }
    }

    private DockerClient newClient(Duration responseTimeout) {
        var config = DefaultDockerClientConfig.createDefaultConfigBuilder()
                .withDockerHost(dockerHost)
                .build();
        var http = new ZerodepDockerHttpClient.Builder()
                .dockerHost(config.getDockerHost())
                .connectionTimeout(CONNECTION_TIMEOUT);
        if (responseTimeout != null) {
            http.responseTimeout(responseTimeout);
        }
        return DockerClientImpl.getInstance(config, http.build());
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
     * notation : son {@code finally} de nettoyage n'a jamais tourné). Appelé par
     * {@link OrphanSweeper}, hors du démarrage du service ; sans effet si le démon est injoignable
     * ou muet (délais du client).
     */
    public int removeOrphans() {
        int removed = 0;
        try {
            // Plusieurs instances peuvent partager le démon (pile e2e + dev, ou un update.sh
            // pendant une correction) : balayer tout ce qui porte l'étiquette tuait une notation
            // EN VOL — 502, tentative supprimée. Le filtre par ÂGE (removable) l'empêche, quel
            // que soit le statut, « running » compris : au-delà de ORPHAN_GRACE_MS, aucune
            // notation ne peut plus posséder le conteneur. Sans « running », un conteneur dont la
            // JVM est morte pendant l'exécution (et dont le code tourne encore) n'était jamais
            // ramassé.
            List<com.github.dockerjava.api.model.Container> orphans = client().listContainersCmd()
                    .withShowAll(true)
                    .withLabelFilter(Map.of(RUNNER_LABEL, "1"))
                    // Filtrés PAR ÂGE plus bas (removable) : terminé ou « created », un conteneur
                    // récent appartient peut-être encore à une notation en cours. Un conteneur
                    // resté « created » (JVM tuée entre create et start)
                    // n'est en revanche ramassé par personne : il n'appartient pas au projet
                    // compose, donc ni `compose up --remove-orphans` ni `docker image prune`
                    // (deploy/update.sh) ne le voient — il s'accumulerait indéfiniment.
                    .withStatusFilter(List.of("created", "running", "exited", "dead"))
                    .exec();
            for (com.github.dockerjava.api.model.Container container : orphans) {
                if (!removable(container)) {
                    continue;
                }
                try {
                    client().removeContainerCmd(container.getId()).withForce(true).exec();
                    removed++;
                } catch (RuntimeException e) {
                    log.warn("Conteneur orphelin {} non supprimé : {}", container.getId(), e.getMessage());
                }
            }
            if (removed > 0) {
                log.info("{} conteneur(s) runner orphelin(s) supprimé(s)", removed);
            }
        } catch (RuntimeException e) {
            log.debug("Balayage des conteneurs orphelins impossible : {}", e.getMessage());
        }
        return removed;
    }

    /**
     * Âge minimal d'un conteneur runner avant de le balayer, QUEL QUE SOIT son statut : au-delà,
     * plus aucune notation ne peut le posséder. Un mur ne dépasse jamais
     * {@code DockerEvaluator.MAX_WALL_MS} (15 min), plus la lecture des journaux (30 s) : 20 min
     * laissent de la marge.
     */
    static final long ORPHAN_GRACE_MS = 20 * 60_000;

    /**
     * Ce conteneur orphelin peut-il être supprimé maintenant ? Seulement s'il a dépassé
     * {@link #ORPHAN_GRACE_MS}, même TERMINÉ : entre la fin du conteneur et la lecture de ses
     * journaux, la notation qui le possède en a encore besoin. Le balayer à cet instant (une
     * autre instance qui démarre, un {@code ./gradlew test} pendant que la pile e2e corrige)
     * rendait « image absente », donc un 502 et une tentative supprimée. « created », lui, est
     * aussi la fenêtre create → start d'une autre instance. Date inconnue : on s'abstient.
     */
    static boolean removable(com.github.dockerjava.api.model.Container container) {
        Long createdSeconds = container.getCreated();
        if (createdSeconds == null || createdSeconds <= 0) {
            return false;
        }
        return System.currentTimeMillis() - createdSeconds * 1000L >= ORPHAN_GRACE_MS;
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
                    // bascule vers les UID du couple noteur/étudiant (SETUID, SETGID) et
                    // nettoyage des groupes de processus (KILL).
                    //
                    // SYS_PTRACE N'EST PLUS ACCORDÉE. Elle servait à tracer le code soumis
                    // (strace) pour DÉTECTER une lecture du harnais — nécessaire quand le harnais
                    // vivait dans un fichier que ce code pouvait ouvrir, c'est-à-dire sur le
                    // chemin « vraie classe de test du framework », retiré de #116. Le harnais
                    // n'entre plus dans aucun processus ni fichier accessible à l'étudiant : il
                    // n'y a rien à surveiller, et le conteneur perd donc le droit de tracer quoi
                    // que ce soit.
                    .withCapDrop(Capability.ALL)
                    .withCapAdd(Capability.CHOWN, Capability.FOWNER, Capability.DAC_OVERRIDE,
                            Capability.SETUID, Capability.SETGID, Capability.KILL)
                    .withSecurityOpts(List.of("no-new-privileges"))
                    // Le verdict est lu par `docker logs` : pilote json-file IMPOSÉ, sans
                    // rotation (le conteneur est supprimé juste après). Hérité du démon, un
                    // pilote « none », « syslog »… ou un max-size bas rendait la sortie illisible
                    // ou tronquée — 502 sur toutes les notations.
                    .withLogConfig(new LogConfig(LogConfig.LoggingType.JSON_FILE, Map.of()))
                    .withAutoRemove(false);
            CreateContainerResponse created = docker.createContainerCmd(image)
                    .withHostConfig(hostConfig)
                    // Étiquette : seul moyen de RETROUVER ces conteneurs. Si la JVM meurt
                    // pendant une notation (OOM, redémarrage, update.sh), le `finally` de
                    // nettoyage ci-dessous ne s'exécute jamais et le conteneur reste en
                    // « Exited » — `OrphanSweeper` les balaie après le démarrage du service.
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

            // Callbacks FERMÉS dans tous les cas : un rappel non fermé gardait sa connexion au
            // démon et son fil de lecture ouverts indéfiniment (attente expirée, journaux lents).
            Integer status;
            try (WaitContainerResultCallback waitCallback =
                         waitClient().waitContainerCmd(containerId).start()) {
                status = waitCallback.awaitStatusCode(wallTimeoutMs, TimeUnit.MILLISECONDS);
            }

            // Accumuler les OCTETS puis décoder UNE fois : un caractère UTF-8 scindé entre deux
            // frames deviendrait sinon « � » dans le détail d'un verdict.
            ByteArrayOutputStream stdout = new ByteArrayOutputStream();
            ByteArrayOutputStream stderr = new ByteArrayOutputStream();
            ResultCallback.Adapter<Frame> logCallback = new ResultCallback.Adapter<>() {
                @Override
                public void onNext(Frame frame) {
                    byte[] payload = frame.getPayload();
                    if (frame.getStreamType() == StreamType.STDOUT) {
                        stdout.write(payload, 0, payload.length);
                    } else {
                        stderr.write(payload, 0, payload.length);
                    }
                }
            };
            try (logCallback) {
                docker.logContainerCmd(containerId)
                        .withStdOut(true)
                        .withStdErr(true)
                        .exec(logCallback);
                // Lecture INCOMPLÈTE : une sortie tronquée n'est pas un verdict. On échoue
                // franchement plutôt que de lire un JSON coupé.
                if (!logCallback.awaitCompletion(logReadTimeout.toMillis(), TimeUnit.MILLISECONDS)) {
                    throw new SandboxException("Journaux du conteneur de notation non lus en "
                            + logReadTimeout.toSeconds() + " s");
                }
            }
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
            // docker-java enveloppe l'InterruptedException de son attente dans une
            // DockerClientException SANS rétablir le drapeau : le catch ci-dessus ne la voyait
            // jamais, et l'interruption (arrêt du service) était perdue.
            if (e.getCause() instanceof InterruptedException) {
                Thread.currentThread().interrupt();
                throw new SandboxException("Notation interrompue", e);
            }
            throw new SandboxException("Échec du conteneur de notation : " + e.getMessage(), e);
        } finally {
            if (containerId != null) {
                // Drapeau d'interruption LEVÉ le temps de la suppression : les deux catch
                // ci-dessus viennent de le rétablir, et un appel au démon sur un fil interrompu
                // échoue aussitôt (le canal du socket se ferme à l'interruption). Le conteneur
                // restait alors vivant, sans propriétaire, jusqu'à son mur de 15 min — hors du
                // compte du limiteur de l'instance suivante. Le drapeau est rétabli ensuite :
                // l'appelant doit toujours voir l'interruption.
                boolean interrupted = Thread.interrupted();
                try {
                    docker.removeContainerCmd(containerId).withForce(true).exec();
                } catch (RuntimeException e) {
                    log.warn("Nettoyage du conteneur {} échoué : {}", containerId, e.getMessage());
                } finally {
                    if (interrupted) {
                        Thread.currentThread().interrupt();
                    }
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
