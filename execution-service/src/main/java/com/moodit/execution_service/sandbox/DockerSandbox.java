package com.moodit.execution_service.sandbox;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.command.InspectContainerResponse;
import com.github.dockerjava.api.command.WaitContainerResultCallback;
import com.github.dockerjava.api.exception.DockerClientException;
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
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Lance le CONTENEUR RUNNER jetable d'une exécution (#116) — notation compilée comme mode exec
 * des interprétés, SQL et vues ({@link RunnerExec}) — et en rapporte la sortie JSON du
 * superviseur. Un conteneur par évaluation : réseau coupé, écritures étudiantes confinées aux
 * trois tmpfs bornés {@code /box}, {@code /tmp} et {@code /dev/shm}, mémoire/PID/CPU bornés,
 * toutes les capacités retirées sauf le minimum du superviseur, {@code no-new-privileges}.
 * {@code SYS_PTRACE} n'est PLUS accordée : elle servait à tracer le code soumis pour détecter une
 * lecture du harnais, ce qui n'a plus d'objet depuis que le harnais n'entre dans aucun fichier ni
 * processus qu'il puisse atteindre (#116). Les fichiers du job sont copiés AVANT le démarrage dans la zone de transit de l'image
 * ({@code /opt/moodit/staging}, 0600 root — {@code docker cp} ne sait pas écrire dans un
 * tmpfs), puis déplacés dans le tmpfs {@code /box} par le superviseur (pas de montage hôte :
 * compatible docker-outside-of-docker) ; le conteneur est détruit à la fin, succès ou non.
 *
 * Une erreur d'infrastructure (démon Docker injoignable, image absente) devient une
 * {@link SandboxException} → 502 de cause « indisponible » : côté core, la tentative en attente
 * est SUPPRIMÉE (quiz:attempt-failed) et l'étudiant resoumet, sauf relance de l'enseignant, ou
 * plafond d'échecs atteint sur un quiz sans reprise (gardée « à revoir », cf. QuizService#failGrading) — pas de rejouage automatique, d'où
 * l'attente interne généreuse (EXEC_INTERNAL_QUEUE_WAIT_MS). Un conteneur qui a TOURNÉ sans
 * rendre de verdict (mur atteint, superviseur muet) lève une {@link NoVerdictException} → 502 de
 * cause « sans_verdict », comptée par core : au plafond, la tentative reste « à revoir ».
 */
public class DockerSandbox {

    private static final Logger log = LoggerFactory.getLogger(DockerSandbox.class);

    /**
     * Sortie (stdout = JSON du superviseur), code de sortie du conteneur, et {@code oomKilled} :
     * l'état {@code State.OOMKilled} de Docker, lu avant la suppression. Il vaut vrai dès qu'UN
     * processus du conteneur a été tué par l'OOM (mesuré : même quand le superviseur a rendu son
     * JSON et que la sortie vaut 0), donc ne dit rien seul.
     */
    public record ContainerRun(String stdout, String stderr, long exitCode, boolean oomKilled) {

        public ContainerRun(String stdout, String stderr, long exitCode) {
            this(stdout, stderr, exitCode, false);
        }

        /**
         * Le SUPERVISEUR lui-même a-t-il été tué par l'OOM ? Sortie 137 (SIGKILL du PID 1) ET
         * OOMKilled : à n'interpréter qu'en l'absence de verdict. Le superviseur est à
         * oom_score_adj -1000 et le code soumis ne peut plus abaisser le sien
         * ({@link DockerSandbox#SUPERVISOR_OOM_SCORE_ADJ}) : ce cas signale une isolation
         * rompue, à corriger — jamais une faute de l'étudiant.
         */
        public boolean supervisorOomKilled() {
            return oomKilled && exitCode == 137;
        }
    }

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

    /**
     * Réglages IPC du conteneur (espace de noms IPC privé, donc sans effet sur l'hôte).
     *
     * <p>Un segment de mémoire partagée System V ({@code shmget}) jamais détruit SURVIT à son
     * créateur : compté dans le cgroup, il n'est ni borné par la taille de {@code /dev/shm}, ni
     * vidé entre deux cas, ni rendu quand le superviseur tue le code soumis. L'OOM du cgroup
     * finissait donc par tuer le superviseur lui-même (PID 1) : conteneur mort sans JSON, 502,
     * tentative supprimée et rejouable à volonté sur une question à tentative unique.
     * {@code shm_rmid_forced=1} fait détruire un segment dès que plus aucun processus n'y est
     * attaché — tuer le code soumis rend alors sa mémoire, et le verdict reste imputable.
     *
     * <p>Les files de messages System V ont le même défaut (elles survivent, et leur contenu est
     * compté dans le cgroup) sans réglage équivalent : {@code msgmni=0} interdit d'en créer.
     * Aucune des chaînes de compilation ni aucun des interpréteurs des runners ne s'en sert.
     *
     * <p>Les SÉMAPHORES System V aussi : un jeu de 32 000 sémaphores coûte environ 2 Mio comptés
     * dans le cgroup, survit à son créateur et n'est borné par aucun rlimit — 250 jeux suffisaient
     * à refaire tuer le superviseur (mesuré : sortie 137 en 1,6 s sous 512 Mo). Le dernier champ de
     * {@code kernel.sem} (semmni, nombre de jeux) à 0 interdit d'en créer ; les trois premiers
     * (semmsl, semmns, semopm) sont au minimum.
     */
    static final Map<String, String> IPC_SYSCTLS = Map.of(
            "kernel.shm_rmid_forced", "1",
            "kernel.msgmni", "0",
            "kernel.sem", "1 1 1 0");

    /**
     * Nombre maximal de fichiers et dossiers (inodes) de chaque tmpfs du conteneur.
     *
     * <p>La taille d'un tmpfs ne borne que le CONTENU des fichiers. Par défaut le noyau y autorise
     * un inode par deux pages de mémoire de l'hôte (deux millions sur 16 Go), et chaque fichier
     * VIDE à nom long coûte environ 1,2 Ko de mémoire noyau comptée dans le cgroup : 320 000
     * fichiers vides suffisaient à faire tuer le superviseur par l'OOM (sortie 137 en 3 s sous
     * 512 Mo, en 24 s sous 1,5 Go) — conteneur mort sans JSON, 502, tentative rejouable.
     *
     * <p>Plafonds LARGES devant le besoin réel, mesuré sur des jobs de 1 et 6 cas : au plus 1 821
     * inodes sur {@code /box} (Go, dont le cache de compilation domine ; moins de 70 pour Java,
     * Rust, C#, C et C++), 3 sur {@code /tmp}, 2 sur {@code /dev/shm}. Au plafond, les trois
     * tmpfs coûtent ensemble une cinquantaine de Mo de mémoire noyau, quelle que soit la mémoire
     * du conteneur.
     */
    static final int BOX_INODES = 32_768;
    static final int TMP_INODES = 4_096;
    static final int SHM_INODES = 1_024;

    /**
     * {@code oom_score_adj} du conteneur, donc du superviseur (PID 1) : -1000, « jamais tué par
     * l'OOM ».
     *
     * <p>Si l'OOM du cgroup tue le PID 1, le conteneur meurt sans JSON : 502, tentative supprimée
     * et rejouable à volonté sur une question à tentative unique. Le superviseur remonte chaque
     * processus qu'il lance, irréversiblement — 1000 pour le code soumis, 500 pour le noteur des
     * compilés et les compilations root (cf. {@code mark_oom_victim} dans supervisor.py et la
     * capacité SYS_RESOURCE plus bas) : ce sont eux que l'OOM tue d'abord.
     * Mais une victime qui ne rend pas sa mémoire assez vite (tables de pages d'un processus
     * soumis, que le moissonneur de l'OOM ne libère pas) laisse l'OOM passer à la suivante : à
     * -500, le superviseur y passait encore (2 courses sur 6, sortie 137, sonde mmap sous
     * 512 Mo) ; à -1000, aucune sur 12 — l'allocation attend que la victime ait fini de mourir.
     *
     * <p>Contrepartie : une mémoire qui ne serait JAMAIS rendue (objet qui survit à son créateur)
     * bloquerait l'OOM au lieu de tuer le conteneur, jusqu'au mur. Ces objets sont bornés
     * ailleurs (tmpfs en taille et en inodes, IPC System V fermée) : ensemble, ils tiennent sous la
     * mémoire du conteneur, ce que vérifie {@code RunnerSandboxIntegrationTest}.
     */
    static final int SUPERVISOR_OOM_SCORE_ADJ = -1000;

    /**
     * Plafond de CHAQUE flux des journaux relus (stdout = JSON du superviseur, stderr). Le
     * superviseur borne déjà ses sorties bien en dessous ; ce plafond empêche qu'une régression
     * de son côté ne devienne un épuisement du tas du service, qui lit ces journaux en mémoire.
     */
    static final int LOG_CAP_BYTES = 16 * 1024 * 1024;

    /**
     * Options du pilote json-file, FIXÉES par conteneur : elles priment sur les log-opts du démon,
     * qui ne complète que les clés absentes. Un seul fichier (rien n'est perdu par rotation) de
     * 128 Mo au plus, et l'écriture BLOQUANTE : en {@code non-blocking}, réglage courant d'un
     * démon, Docker jette des messages quand son tampon est plein et le verdict relu est troué.
     * Taille : le superviseur borne ce qu'il émet (1,2 Mo par flux en mode exec, 64 Kio par cas
     * en notation, cas plafonnés à 100 : quelques Mio), et l'enveloppe du pilote multiplie au
     * pire par 6 (un caractère de contrôle ou {@code <} devient un échappement Unicode de six
     * caractères) ; 128 Mo laisse
     * la marge. Une régression du superviseur au-delà de {@link #LOG_CAP_BYTES} par flux reste
     * vue par le plafond de lecture.
     */
    static final Map<String, String> LOG_OPTS =
            Map.of("max-size", "128m", "max-file", "1", "mode", "blocking");

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
    /** Plafond des journaux relus, par flux. Modifiable par les tests seulement. */
    int logCapBytes = LOG_CAP_BYTES;
    /**
     * Conteneurs EN VOL de cette instance, pour {@link #removeInFlight()} : à l'arrêt du service,
     * rien ne garantit que le {@code finally} de {@link #run} aille au bout avant la fin de la JVM.
     */
    private final Set<String> inFlight = ConcurrentHashMap.newKeySet();

    /** Conteneurs en vol de CETTE instance (copie) : un test n'agit que sur les siens. */
    Set<String> inFlightContainers() {
        return Set.copyOf(inFlight);
    }
    /** Arrêt du service engagé : plus aucun conteneur n'est lancé (cf. removeInFlight). */
    private volatile boolean closed;
    private volatile DockerClient client;
    private volatile DockerClient waitClient;

    public DockerSandbox(String dockerHost, long memoryMb, long pidsLimit, double cpus) {
        this(dockerHost, memoryMb, pidsLimit, cpus, RESPONSE_TIMEOUT);
    }

    /** Pour les tests : délai de réponse raccourci. */
    DockerSandbox(String dockerHost, long memoryMb, long pidsLimit, double cpus, Duration responseTimeout) {
        // Bornes refusées AU DÉMARRAGE : Docker lit 0 (et -1 pour les PID) comme « illimité ».
        // Un SANDBOX_MEMORY_MB, SANDBOX_PIDS_LIMIT ou SANDBOX_CPUS à 0 lançait donc des
        // conteneurs de notation sans borne mémoire, PID ou CPU, sans que rien ne le signale ;
        // une mémoire négative faisait échouer chaque notation en 502.
        if (memoryMb < MIN_MEMORY_MB || memoryMb > Long.MAX_VALUE / (1024 * 1024)) {
            throw new IllegalArgumentException("Limite du bac à sable invalide : "
                    + "app.sandbox.memory-mb (SANDBOX_MEMORY_MB) doit valoir au moins "
                    + MIN_MEMORY_MB + " Mo (minimum de Docker), reçu " + memoryMb);
        }
        if (pidsLimit < 1) {
            throw new IllegalArgumentException("Limite du bac à sable invalide : "
                    + "app.sandbox.pids-limit (SANDBOX_PIDS_LIMIT) doit valoir au moins 1 "
                    + "(0 et -1 signifient « illimité » pour Docker), reçu " + pidsLimit);
        }
        // NaN, nul, négatif ou fraction sous le nanoCPU : tous donnent nanos ≤ 0.
        long nanos = (long) (cpus * 1_000_000_000L);
        if (Double.isInfinite(cpus) || nanos <= 0) {
            throw new IllegalArgumentException("Limite du bac à sable invalide : "
                    + "app.sandbox.cpus (SANDBOX_CPUS) doit être strictement positif "
                    + "(0 signifie « illimité » pour Docker), reçu " + cpus);
        }
        this.dockerHost = dockerHost == null || dockerHost.isBlank() ? defaultDockerHost() : dockerHost;
        this.memoryBytes = memoryMb * 1024 * 1024;
        this.pidsLimit = pidsLimit;
        this.nanoCpus = nanos;
        this.responseTimeout = responseTimeout;
    }

    /** Plus petite mémoire de conteneur que Docker accepte (6 Mo). */
    static final long MIN_MEMORY_MB = 6;

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

    // Initialisation PARESSEUSE : le service doit démarrer même sans démon Docker ; chaque
    // exécution (tous langages) échoue alors en 502 « sandbox indisponible », sans bloquer le reste.
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
        return removable(container, System.currentTimeMillis());
    }

    /** Même règle à l'instant {@code nowMs} donné (borne exacte testable sans horloge). */
    static boolean removable(com.github.dockerjava.api.model.Container container, long nowMs) {
        Long createdSeconds = container.getCreated();
        if (createdSeconds == null || createdSeconds <= 0) {
            return false;
        }
        return nowMs - createdSeconds * 1000L >= ORPHAN_GRACE_MS;
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
                    // Écritures de l'UID étudiant CONFINÉES aux trois tmpfs bornés ci-dessous
                    // (comptés dans la mémoire du conteneur) : les images verrouillent leurs
                    // répertoires monde-inscriptibles (/var/tmp, /go, cargo… — cf. Dockerfiles),
                    // il ne reste donc que /box, /tmp et /dev/shm — le code étudiant ne peut pas
                    // remplir le disque de l'hôte. (`ReadonlyRootfs` ferait pareil en plus strict, mais le
                    // démon refuse alors TOUT `docker cp`, même vers un tmpfs.) /box porte le job
                    // ET les artefacts de compilation (cible cargo, GOCACHE…) donc PAS de noexec ;
                    // /tmp couvre les outils qui l'exigent en dur (JVM hsperfdata, mono, sort…).
                    // Tailles DÉRIVÉES de la mémoire du conteneur : un tmpfs est compté dans
                    // le cgroup, les coder en dur les faisait occuper jusqu'à 83 % de la
                    // mémoire quand SANDBOX_MEMORY_MB est abaissé (1 Go en prod).
                    .withTmpFs(Map.of(
                            // `exec` EXPLICITE : les tmpfs Docker sont noexec par défaut, et les
                            // binaires de test compilés (Go/Rust/C/C++) s'exécutent depuis /box.
                            // `nr_inodes` : `size=` ne borne que les OCTETS. Un fichier vide
                            // coûte quand même de la mémoire noyau (inode + entrée de
                            // répertoire), comptée dans le cgroup — cf. BOX_INODES.
                            "/box", "rw,nosuid,exec,size=" + boxSizeMb() + "m,nr_inodes=" + BOX_INODES,
                            "/tmp", "rw,nosuid,noexec,size=" + tmpSizeMb() + "m,nr_inodes=" + TMP_INODES,
                            // Docker monte TOUJOURS /dev/shm (tmpfs 1777, 64 Mo par défaut) :
                            // sans cette entrée, il échappait à l'inventaire des points
                            // d'écriture de l'UID étudiant. Borné et noexec comme /tmp.
                            "/dev/shm", "rw,nosuid,noexec,size=" + shmSizeMb() + "m,nr_inodes="
                                    + SHM_INODES))
                    // IPC System V : mémoire comptée dans le cgroup mais HORS des tmpfs bornés,
                    // et qui survit au processus qui l'a créée (cf. IPC_SYSCTLS).
                    .withSysctls(IPC_SYSCTLS)
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
                    //
                    // SYS_RESOURCE : seule façon de rendre IRRÉVERSIBLE le oom_score_adj à 1000
                    // posé sur chaque processus lancé (le noyau ne relève le plancher
                    // oom_score_adj_min que si l'écrivain détient cette capacité). Sans elle, le
                    // code soumis redescendait sa valeur au niveau du PID 1 et faisait tuer le
                    // superviseur par tout objet noyau tenu à faible RSS (sortie 137 mesurée :
                    // tampons de sockets, memfd, VMA). Coût : seuls les processus ROOT la
                    // détiennent — le superviseur et ce qu'il lance par preexec_compile :
                    // compilations du noteur, sonde des noms réservés, javap, et la compilation
                    // du serveur Java (classes du code soumis sur le classpath), tous déjà root
                    // avec DAC_OVERRIDE et SETUID. Elle ne lève aucune limite de cgroup. Le
                    // code soumis n'en
                    // reçoit aucune : setuid efface ses capacités, no-new-privileges l'empêche
                    // d'en regagner (CapEff à 0, mesuré).
                    .withCapDrop(Capability.ALL)
                    .withCapAdd(Capability.CHOWN, Capability.FOWNER, Capability.DAC_OVERRIDE,
                            Capability.SETUID, Capability.SETGID, Capability.KILL,
                            Capability.SYS_RESOURCE)
                    .withOomScoreAdj(SUPERVISOR_OOM_SCORE_ADJ)
                    .withSecurityOpts(List.of("no-new-privileges"))
                    // Le verdict est lu par `docker logs` : pilote json-file IMPOSÉ, et sa taille
                    // aussi (LOG_OPTS). Hérité du démon, un pilote « none », « syslog »… rendait
                    // la sortie illisible — 502 sur toutes les notations ; et le démon complète
                    // une configuration json-file avec SES log-opts pour chaque clé absente : un
                    // max-size bas réglé sur l'hôte tronquait la sortie, et une sortie tronquée
                    // après la ligne témoin est comptée « sans verdict » contre l'étudiant.
                    .withLogConfig(new LogConfig(LogConfig.LoggingType.JSON_FILE, LOG_OPTS))
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
            inFlight.add(containerId);
            // Arrêt engagé PENDANT la création : removeInFlight a pu copier l'ensemble avant cet
            // ajout, et ce conteneur lui échapperait. Testé APRÈS l'ajout — l'un des deux le voit
            // forcément ; le `finally` ci-dessous le supprime.
            if (closed) {
                throw new SandboxException("Service en cours d'arrêt : notation non lancée");
            }

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
            long waitStarted = System.nanoTime();
            try (WaitContainerResultCallback waitCallback =
                         waitClient().waitContainerCmd(containerId).start()) {
                status = waitCallback.awaitStatusCode(wallTimeoutMs, TimeUnit.MILLISECONDS);
            } catch (DockerClientException e) {
                if (e.getCause() instanceof InterruptedException) {
                    throw e;   // arrêt du service : traité plus bas comme une interruption
                }
                // MUR atteint : le conteneur a tourné jusqu'au bout de son temps sans rendre de
                // verdict. Le budget du superviseur est calculé pour l'éviter ; s'il arrive, le
                // code soumis a pu y jouer un rôle — cause « sans verdict », comptée par core.
                // Seulement si le mur s'est réellement écoulé : docker-java lève la même
                // exception quand le flux d'attente se coupe (démon redémarré, connexion
                // perdue), et ces pannes-là ne doivent rien coûter à l'étudiant.
                if (TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - waitStarted) < wallTimeoutMs) {
                    throw new SandboxException("Attente du conteneur de notation coupée : "
                            + e.getMessage(), e);
                }
                // Mur écoulé : le démon le confirme-t-il ? Un démon bloqué peut garder le flux
                // d'attente ouvert sans jamais notifier la fin d'un conteneur qui a rendu son
                // verdict depuis longtemps. Arrêté, on lit sa sortie comme d'habitude ;
                // inspection en échec, c'est le démon qui est en panne (« indisponible ») ; encore
                // en marche, ou état absent (rien ne prouve l'arrêt), il a tourné jusqu'au mur.
                status = exitCodeIfStopped(containerId, e);
                if (status == null) {
                    throw new NoVerdictException("Mur du conteneur de notation atteint ("
                            + wallTimeoutMs + " ms) : aucun verdict", e);
                }
            }
            // Service en cours d'ARRÊT : removeInFlight vient de supprimer ce conteneur, d'où une
            // sortie vide qui passerait pour un superviseur muet. Panne, pas « sans verdict ».
            if (closed) {
                throw new SandboxException("Service en cours d'arrêt : notation interrompue");
            }
            boolean oomKilled = oomKilled(containerId);

            // Accumuler les OCTETS puis décoder UNE fois : un caractère UTF-8 scindé entre deux
            // frames deviendrait sinon « � » dans le détail d'un verdict.
            ByteArrayOutputStream stdout = new ByteArrayOutputStream();
            ByteArrayOutputStream stderr = new ByteArrayOutputStream();
            AtomicBoolean overflow = new AtomicBoolean();
            ResultCallback.Adapter<Frame> logCallback = new ResultCallback.Adapter<>() {
                @Override
                public void onNext(Frame frame) {
                    byte[] payload = frame.getPayload();
                    ByteArrayOutputStream target =
                            frame.getStreamType() == StreamType.STDOUT ? stdout : stderr;
                    // Au-delà du plafond, plus rien n'est gardé : le flux est lu jusqu'au bout
                    // (le rappel doit se terminer), mais la mémoire reste bornée.
                    if (target.size() + payload.length > logCapBytes) {
                        overflow.set(true);
                        return;
                    }
                    target.write(payload, 0, payload.length);
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
            // Arrêt engagé PENDANT la lecture des journaux : removeInFlight a pu supprimer le
            // conteneur en cours de lecture, et la sortie tronquée passerait pour un superviseur
            // muet — un échec compté contre l'étudiant. Panne, comme pendant l'attente.
            if (closed) {
                throw new SandboxException("Service en cours d'arrêt : journaux de notation interrompus");
            }
            // Sortie TRONQUÉE : pas un verdict non plus (même règle que la lecture incomplète).
            // Le superviseur borne ce qu'il émet : une sortie démesurée vient du conteneur.
            if (overflow.get()) {
                throw new NoVerdictException("Journaux du conteneur de notation au-delà de "
                        + logCapBytes + " octets");
            }
            return new ContainerRun(stdout.toString(StandardCharsets.UTF_8),
                    stderr.toString(StandardCharsets.UTF_8), status == null ? -1 : status,
                    oomKilled);
        } catch (NotFoundException e) {
            // Un 404 APRÈS la création vise le conteneur, pas l'image : supprimé en vol (arrêt
            // du service, removeInFlight). « Image runner absente » égarait le diagnostic.
            if (containerId != null) {
                throw new SandboxException(closed
                        ? "Service en cours d'arrêt : conteneur de notation supprimé"
                        : "Conteneur de notation disparu pendant la notation", e);
            }
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
                    inFlight.remove(containerId);
                    if (interrupted) {
                        Thread.currentThread().interrupt();
                    }
                }
            }
        }
    }

    /**
     * Code de sortie d'un conteneur déjà ARRÊTÉ, {@code null} s'il tourne encore. Appelé quand
     * l'attente expire au mur. Une inspection en échec est une panne du démon :
     * {@link SandboxException} (cause « indisponible »), jamais un échec compté contre l'étudiant.
     * Un état absent, ou sans indicateur de marche, vaut « encore en marche » : rien ne prouve
     * l'arrêt, et conclure à tort à l'arrêt ouvrirait un essai non compté.
     */
    private Integer exitCodeIfStopped(String containerId, RuntimeException waitFailure) {
        InspectContainerResponse.ContainerState state;
        try {
            state = client().inspectContainerCmd(containerId).exec().getState();
        } catch (RuntimeException e) {
            e.addSuppressed(waitFailure);
            throw new SandboxException("Conteneur de notation au mur, inspection en échec : "
                    + e.getMessage(), e);
        }
        if (state == null || !Boolean.FALSE.equals(state.getRunning())) {
            return null;
        }
        log.warn("Attente du conteneur {} expirée au mur alors qu'il était arrêté : démon muet",
                containerId);
        Long exitCode = state.getExitCodeLong();
        return exitCode == null ? -1 : exitCode.intValue();
    }

    /**
     * {@code State.OOMKilled} du conteneur, lu avant sa suppression (#116, S3). Un échec de lecture
     * n'empêche pas la notation : faux, et c'est journalisé.
     */
    private boolean oomKilled(String containerId) {
        try {
            return Boolean.TRUE.equals(
                    client().inspectContainerCmd(containerId).exec().getState().getOOMKilled());
        } catch (RuntimeException e) {
            log.warn("État OOMKilled du conteneur {} illisible : {}", containerId, e.getMessage());
            return false;
        }
    }

    /**
     * Supprime les conteneurs encore en vol. Appelé à l'ARRÊT du service (méthode de destruction
     * du bean, cf. {@code SandboxBeans}) : la suppression vivait seulement dans le {@code finally}
     * d'un fil de requête, que la JVM n'attend pas. Un conteneur survivant tournait alors jusqu'au
     * bout de son mur (15 min), hors du compte du limiteur de l'instance suivante, et le balayeur
     * ne le ramassait qu'après {@link #ORPHAN_GRACE_MS}. Supprimer deux fois est sans effet :
     * le {@code finally} de {@link #run} tolère un conteneur déjà parti.
     */
    public int removeInFlight() {
        closed = true;
        int removed = 0;
        for (String id : List.copyOf(inFlight)) {
            try {
                client().removeContainerCmd(id).withForce(true).exec();
                removed++;
            } catch (RuntimeException e) {
                log.warn("Conteneur en vol {} non supprimé à l'arrêt : {}", id, e.getMessage());
            }
        }
        if (removed > 0) {
            log.info("{} conteneur(s) runner en vol supprimé(s) à l'arrêt", removed);
        }
        return removed;
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
