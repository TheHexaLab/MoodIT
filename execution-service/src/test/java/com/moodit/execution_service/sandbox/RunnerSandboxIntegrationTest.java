package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Filet d'INTÉGRATION du CONTENEUR runner, par opposition à la justesse de la notation
 * ({@link RpcGradingIntegrationTest}). Ce qui est vérifié ici ne dépend pas de la forme du
 * harnais mais de l'isolation et des budgets : pas de sortie réseau, {@code /tmp} non
 * exécutable, boucle infinie interrompue, mur plafonné d'un appel public, plancher VM, poids des
 * cas, erreur de compilation expliquée.
 *
 * <p>Ces tests viennent de l'ancienne matrice anti-triche du chemin « vraie classe de test du
 * framework », retiré de #116 : son harnais était compilé AVEC le code de l'étudiant, donc
 * falsifiable, et les trente-quatre tests qui mesuraient ses garde-fous n'avaient plus d'objet.
 * Ceux-ci, en revanche, portent sur le conteneur — ils restent vrais et nécessaires.
 *
 * <p>Préconditions : démon Docker joignable + images construites ({@code docker/runners/build.sh}).
 * {@code SANDBOX_REQUIRED=true} (CI) : une précondition manquante FAIT ÉCHOUER le test — le filet
 * ne doit pas s'ignorer en silence. Sinon (dev local) : test ignoré (assume).
 */
class RunnerSandboxIntegrationTest {

    private static final boolean SANDBOX_REQUIRED =
            Boolean.parseBoolean(System.getenv().getOrDefault("SANDBOX_REQUIRED", "false"));

    private final DockerSandbox sandbox = new DockerSandbox("", 1536, 512, 2.0);
    private final DockerEvaluator evaluator = new DockerEvaluator(sandbox, "moodit-runner-",
            System.getenv().getOrDefault("MOODIT_RUNNER_TAG", "latest"));

    /** Harnais booléen de référence : `doubler(5) == 10`, dans la forme de chaque langage. */
    private static final String GO_HARNESS = "return doubler(5) == 10";
    private static final String GO_OK =
            "package main\n\nfunc doubler(n int) int { return n * 2 }\n\nfunc main() {}\n";

    private static void gate(boolean available, String what) {
        if (available) {
            return;
        }
        if (SANDBOX_REQUIRED) {
            fail(what + " — indisponible alors que SANDBOX_REQUIRED=true : le filet d'isolation ne "
                    + "doit PAS s'ignorer en CI.");
        }
        assumeTrue(false, what + " — test d'intégration ignoré (dev local, SANDBOX_REQUIRED absent)");
    }

    private void require(String language) {
        gate(evaluator.sandbox().available(), "Démon Docker injoignable");
        String image = evaluator.imageFor(HarnessProjects.runnerLanguage(language));
        gate(evaluator.sandbox().imagePresent(image),
                "Image runner absente : " + image + " (docker/runners/build.sh)");
    }

    private List<TestResult> evaluate(String language, String code, String harness) {
        return evaluator.evaluate(language, code,
                List.of(new TestCaseInput("cas", harness, 1)), null);
    }

    // ─────────────────────────── Isolation du conteneur ───────────────────────────

    @Test
    void network_egress_refused_for_student_code() {
        require("Go");
        // --network none : aucune interface hors loopback, donc connect() échoue IMMÉDIATEMENT
        // (réseau inatteignable) — aucune dépendance à un hôte externe, aucune attente. Sans
        // cette garantie, le code soumis exfiltrerait sa réponse ou le nonce depuis le VPS.
        String probe = """
                package main

                import "net"

                func doubler(n int) int {
                    conn, err := net.Dial("tcp", "1.1.1.1:80")
                    if err == nil {
                        conn.Close()
                        return n * 2 // sortie réseau obtenue : l'isolation est rompue
                    }
                    return 0
                }

                // TÉMOIN : ne touche pas au réseau, et doit réussir. Sans lui, ce test passait À
                // VIDE — un programme qui ne compile plus rend un cas faux, exactement comme un
                // `connect()` refusé, et l'assertion s'en contentait.
                func temoin(n int) int { return n * 2 }

                func main() {}
                """;
        List<TestResult> r = evaluator.evaluate("Go", probe, List.of(
                new TestCaseInput("réseau", GO_HARNESS, 1),
                new TestCaseInput("témoin", "return temoin(5) == 10", 1)), null);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(1).passed())
                .withFailMessage("le témoin doit réussir, sinon la sonde réseau ne prouve rien "
                        + "(le programme n'a pas compilé ou n'a pas tourné) : %s", r.get(1))
                .isTrue();
    }

    @Test
    void sysv_ipc_cannot_outlive_the_student_process() {
        require("C");
        // Mémoire partagée System V : comptée dans le cgroup, mais hors des tmpfs bornés, et elle
        // SURVIT au processus qui l'a créée. Sans `kernel.shm_rmid_forced=1`, des segments jamais
        // détruits s'accumulaient jusqu'à l'OOM du cgroup, qui tuait le superviseur : conteneur
        // mort sans JSON, donc une SandboxException ici (502, tentative rejouable à volonté).
        // Conteneur à 512 Mo pour que la sonde reste courte ; elle demande 800 Mo.
        DockerEvaluator small = new DockerEvaluator(
                new DockerSandbox("", 512, 512, 2.0), "moodit-runner-",
                System.getenv().getOrDefault("MOODIT_RUNNER_TAG", "latest"));
        String probe = """
                #include <string.h>
                #include <sys/ipc.h>
                #include <sys/msg.h>
                #include <sys/sem.h>
                #include <sys/shm.h>

                #define MORCEAU (4 << 20)

                /* Segments DÉTACHÉS, jamais détruits : avec le réglage, chacun disparaît à son
                   détachement et la boucle va au bout ; sans lui, 800 Mo s'accumulent. */
                int doubler(int n) {
                    for (int i = 0; i < 200; i++) {
                        int id = shmget(IPC_PRIVATE, MORCEAU, IPC_CREAT | 0600);
                        if (id < 0) { return 0; }
                        void *p = shmat(id, 0, 0);
                        if (p == (void *) -1) { return 0; }
                        memset(p, 1, MORCEAU);
                        shmdt(p);
                    }
                    return n * 2;
                }

                /* Segments GARDÉS attachés : la mémoire appartient au processus, que la limite
                   tue ; ils disparaissent avec lui, et le cas suivant tourne encore. */
                int garder(int n) {
                    for (int i = 0; i < 200; i++) {
                        int id = shmget(IPC_PRIVATE, MORCEAU, IPC_CREAT | 0600);
                        if (id < 0) { return 0; }
                        void *p = shmat(id, 0, 0);
                        if (p == (void *) -1) { return 0; }
                        memset(p, 1, MORCEAU);
                    }
                    return n * 2; /* 800 Mo tenus sous une limite de 512 Mo : elle est rompue */
                }

                /* Files de messages : même défaut, aucune ne doit pouvoir être créée. */
                int file(int n) {
                    return msgget(IPC_PRIVATE, IPC_CREAT | 0600) >= 0 ? n * 2 : 0;
                }

                /* Jeux de sémaphores : environ 2 Mio chacun, hors tmpfs, et ils survivent aussi.
                   400 jeux pèseraient 800 Mo ; aucun ne doit pouvoir être créé. */
                int semaphores(int n) {
                    int crees = 0;
                    for (int i = 0; i < 400; i++) {
                        if (semget(IPC_PRIVATE, 32000, IPC_CREAT | 0600) >= 0) { crees++; }
                    }
                    return crees > 0 ? n * 2 : 0;
                }

                int temoin(int n) { return n * 2; }
                """;
        List<TestResult> r = small.evaluate("C", probe, List.of(
                new TestCaseInput("segments détachés", "return doubler(5) == 10;", 1),
                new TestCaseInput("segments gardés", "return garder(5) == 10;", 1),
                new TestCaseInput("file de messages", "return file(5) == 10;", 1),
                new TestCaseInput("sémaphores", "return semaphores(5) == 10;", 1),
                new TestCaseInput("témoin", "return temoin(5) == 10;", 1)), null);
        assertThat(r.get(0).passed())
                .withFailMessage("les segments détachés doivent être rendus au fur et à mesure "
                        + "(kernel.shm_rmid_forced) : %s", r.get(0))
                .isTrue();
        assertThat(r.get(1).passed()).isFalse();
        assertThat(r.get(2).passed()).isFalse();
        assertThat(r.get(3).passed()).isFalse();
        // Le superviseur MÉLANGE l'ordre des cas : le témoin n'est pas forcément noté après les
        // sondes. Sa réussite prouve que le programme compile et tourne (sans quoi les refus
        // ci-dessus ne prouveraient rien) ; la survie du conteneur, elle, est prouvée par le
        // simple retour d'evaluate (un superviseur tué lève une SandboxException).
        assertThat(r.get(4).passed())
                .withFailMessage("le témoin doit réussir : le programme compile et tourne : %s",
                        r.get(4))
                .isTrue();
    }

    @Test
    void empty_files_cannot_exhaust_the_container_memory() {
        require("C");
        // `size=` d'un tmpfs ne borne que les octets : sans `nr_inodes`, des centaines de milliers
        // de fichiers VIDES consommaient la mémoire noyau du cgroup jusqu'à faire tuer le
        // superviseur (conteneur mort sans JSON → SandboxException ici, 502 en prod). La sonde
        // tente 400 000 créations sur /tmp et sur /dev/shm, les deux tmpfs monde-inscriptibles.
        // Le troisième, /box, n'est inscriptible par l'UID étudiant que dans les dossiers que le
        // superviseur lui attribue (work/ à l'exécution, etu_build/ pour la compilation de son
        // code, gocache_etu/ et gopath_etu/ en Go) ; il porte son propre plafond (BOX_INODES) :
        // il n'est pas sondé ici, le remplir jusqu'à 32 768 inodes allongerait le test sans rien
        // vérifier de plus du mécanisme.
        DockerEvaluator small = new DockerEvaluator(
                new DockerSandbox("", 512, 512, 2.0), "moodit-runner-",
                System.getenv().getOrDefault("MOODIT_RUNNER_TAG", "latest"));
        String probe = """
                #include <fcntl.h>
                #include <stdio.h>
                #include <sys/stat.h>
                #include <unistd.h>

                /* Fichiers vides à nom long, mille par dossier, jusqu'au premier refus. */
                static long remplir(const char *racine) {
                    char nom[400];
                    long crees = 0;
                    for (long i = 0; i < 400000; i++) {
                        if (i % 1000 == 0) {
                            snprintf(nom, sizeof nom, "%s/d%ld", racine, i / 1000);
                            if (mkdir(nom, 0700) != 0) { break; }
                            crees++;
                        }
                        snprintf(nom, sizeof nom, "%s/d%ld/%0200ld", racine, i / 1000, i);
                        int fd = open(nom, O_CREAT | O_WRONLY, 0600);
                        if (fd < 0) { break; }
                        close(fd);
                        crees++;
                    }
                    return crees;
                }

                /* Réussit si la sonde a VRAIMENT créé des fichiers (elle tourne) et a été ARRÊTÉE
                   par le plafond bien avant ses 400 000 créations. */
                int doubler(int n) {
                    long tmp = remplir("/tmp");
                    long shm = remplir("/dev/shm");
                    return (tmp > 100 && tmp < 10000 && shm > 100 && shm < 10000) ? n * 2 : 0;
                }

                int temoin(int n) { return n * 2; }
                """;
        List<TestResult> r = small.evaluate("C", probe, List.of(
                new TestCaseInput("inodes", "return doubler(5) == 10;", 1),
                new TestCaseInput("témoin", "return temoin(5) == 10;", 1)), null);
        assertThat(r.get(0).passed())
                .withFailMessage("la création de fichiers doit être arrêtée par nr_inodes, après "
                        + "avoir commencé : %s", r.get(0))
                .isTrue();
        // Ordre des cas MÉLANGÉ par le superviseur, et le témoin ne touche ni /tmp ni /dev/shm :
        // il prouve seulement que le programme compile et tourne. La survie du conteneur est
        // prouvée par le retour d'evaluate ; la purge des tmpfs entre deux cas, par
        // shared_tmpfs_are_purged_between_cases.
        assertThat(r.get(1).passed())
                .withFailMessage("le témoin doit réussir : le programme compile et tourne : %s",
                        r.get(1))
                .isTrue();
    }

    @Test
    void shared_tmpfs_are_purged_between_cases() {
        require("C");
        // Isolation entre les cas : /tmp et /dev/shm sont communs à tout le conteneur, et le
        // dossier du cas sous /box (dont work/tmp, le TMPDIR de l'étudiant) survivrait s'il
        // n'était pas libéré. Un fichier déposé au cas N (nonce exfiltré, relais) serait lisible
        // au cas N+1. Le superviseur purge /tmp et /dev/shm à la fin de chaque exécution
        // (run_proc, run_pair) et entre deux cas (after_case_cleanup), puis supprime
        // /box/cases/<N>.
        //
        // Même motif que no_submitted_process_survives_into_the_next_case : le superviseur
        // MÉLANGE l'ordre des cas, donc trois cas IDENTIQUES. Chacun vérifie EN ENTRÉE qu'aucune
        // marque d'un autre cas n'est visible, puis pose les siennes ; quel que soit l'ordre
        // tiré, deux d'entre eux en suivent un autre. On cherche la MARQUE plutôt qu'un dossier
        // strictement vide : un outil du conteneur peut légitimement y laisser une entrée (la JVM
        // pose hsperfdata dans /tmp), et ce n'est pas ce qu'on vérifie ici.
        String probe = """
                #include <dirent.h>
                #include <fcntl.h>
                #include <stdio.h>
                #include <stdlib.h>
                #include <string.h>
                #include <unistd.h>

                #define MARQUE "sonde-purge"

                /* Vrai si `dossier` contient une marque, ou s'il est illisible (la sonde ne
                   prouverait alors rien : on échoue plutôt que de passer à vide). */
                static int marque_dans(const char *dossier) {
                    DIR *d = opendir(dossier);
                    if (!d) { return 1; }
                    struct dirent *e;
                    int trouve = 0;
                    while (!trouve && (e = readdir(d))) {
                        trouve = strncmp(e->d_name, MARQUE, strlen(MARQUE)) == 0;
                    }
                    closedir(d);
                    return trouve;
                }

                /* Vrai si le TMPDIR d'un AUTRE cas (/box/cases/<k>/work/tmp) porte encore une
                   marque : son dossier de cas a survécu. */
                static int marque_dans_un_autre_cas(int mien) {
                    DIR *d = opendir("/box/cases");
                    if (!d) { return 1; }
                    struct dirent *e;
                    char chemin[512];
                    int trouve = 0;
                    while (!trouve && (e = readdir(d))) {
                        if (e->d_name[0] < '0' || e->d_name[0] > '9' || atoi(e->d_name) == mien) {
                            continue;
                        }
                        snprintf(chemin, sizeof chemin, "/box/cases/%s/work/tmp/" MARQUE,
                                 e->d_name);
                        trouve = access(chemin, F_OK) == 0;
                    }
                    closedir(d);
                    return trouve;
                }

                static int poser(const char *dossier) {
                    char chemin[512];
                    snprintf(chemin, sizeof chemin, "%s/" MARQUE, dossier);
                    int fd = open(chemin, O_CREAT | O_WRONLY, 0600);
                    if (fd < 0) { return 0; }
                    close(fd);
                    return 1;
                }

                int sonde(int n) {
                    const char *tmpdir = getenv("TMPDIR");
                    int mien = -1;
                    if (!tmpdir || sscanf(tmpdir, "/box/cases/%d/", &mien) != 1) { return 0; }
                    int propre = !marque_dans("/tmp") && !marque_dans("/dev/shm")
                            && !marque_dans_un_autre_cas(mien);
                    /* Les marques DOIVENT être posées : sinon le cas suivant ne trouverait rien
                       à voir, et le test passerait à vide. */
                    int pose = poser("/tmp") && poser("/dev/shm") && poser(tmpdir);
                    return propre && pose ? n * 2 : 0;
                }
                """;
        List<TestResult> r = evaluator.evaluate("C", probe, List.of(
                new TestCaseInput("un", "return sonde(1) == 2;", 1),
                new TestCaseInput("deux", "return sonde(2) == 4;", 1),
                new TestCaseInput("trois", "return sonde(3) == 6;", 1)), null);
        assertThat(r)
                .withFailMessage("chaque cas doit démarrer sans marque d'un autre cas dans /tmp, "
                        + "/dev/shm ni dans le TMPDIR d'un autre cas sous /box : %s", r)
                .extracting(TestResult::passed).containsExactly(true, true, true);
    }

    @Test
    void out_of_memory_never_kills_the_supervisor() {
        require("C");
        // Le superviseur (PID 1) est à -1000, et chaque processus qu'il lance à 1000, sans retour
        // possible (CAP_SYS_RESOURCE relève le plancher, cf. mark_oom_victim). Avant : le code
        // soumis ramenait son oom_score_adj au niveau du PID 1, puis tenait de la mémoire noyau
        // HORS de son RSS (memfd jamais projeté) ; l'OOM du cgroup tuait alors le plus lourd,
        // le superviseur — conteneur mort sans JSON (sortie 137 mesurée), donc une
        // SandboxException ici, 502 et tentative rejouable en prod. Conteneur à 512 Mo ; la
        // sonde demande 2 Go.
        DockerEvaluator small = new DockerEvaluator(
                new DockerSandbox("", 512, 512, 2.0), "moodit-runner-",
                System.getenv().getOrDefault("MOODIT_RUNNER_TAG", "latest"));
        String probe = """
                #define _GNU_SOURCE
                #include <dirent.h>
                #include <fcntl.h>
                #include <stdio.h>
                #include <stdlib.h>
                #include <string.h>
                #include <sys/mman.h>
                #include <unistd.h>

                /* Le plus bas oom_score_adj que le noyau accepte ; 1000 si aucun. */
                static int abaisser(void) {
                    static const char *valeurs[] = {"-1000", "-500", "0", "500", "999"};
                    for (unsigned i = 0; i < 5; i++) {
                        int fd = open("/proc/self/oom_score_adj", O_WRONLY);
                        if (fd < 0) { return 1000; }
                        int ok = write(fd, valeurs[i], strlen(valeurs[i])) > 0;
                        close(fd);
                        if (ok) { return atoi(valeurs[i]); }
                    }
                    return 1000;
                }

                /* memfd JAMAIS projeté : compté dans le cgroup, absent du RSS. 31 Mo par
                   fichier (RLIMIT_FSIZE vaut aussi pour un memfd). Rend les Mo écrits. */
                static long remplir(long mo) {
                    static char bloc[1 << 20];
                    memset(bloc, 1, sizeof bloc);
                    long ecrits = 0;
                    while (ecrits < mo) {
                        int fd = memfd_create("m", 0);
                        if (fd < 0) { return ecrits; }
                        for (int k = 0; k < 31 && ecrits < mo; k++, ecrits++) {
                            if (write(fd, bloc, sizeof bloc) != (long) sizeof bloc) { return ecrits; }
                        }
                    }
                    return ecrits;
                }

                static int lire_adj(const char *chemin) {
                    char b[16] = {0};
                    int fd = open(chemin, O_RDONLY);
                    if (fd < 0) { return 99999; }
                    int lu = read(fd, b, sizeof b - 1);
                    close(fd);
                    return lu > 0 ? atoi(b) : 99999;
                }

                /* Le noteur (UID + 1, lancé à côté) passe APRÈS le code soumis : 500 contre
                   1000. Cherché dans /proc (oom_score_adj est lisible par tous). */
                static int noteur_second(void) {
                    char chemin[300], ligne[256];
                    int trouve = 0;
                    DIR *d = opendir("/proc");
                    struct dirent *e;
                    while (d && !trouve && (e = readdir(d))) {
                        snprintf(chemin, sizeof chemin, "/proc/%s/status", e->d_name);
                        FILE *f = fopen(chemin, "r");
                        if (!f) { continue; }
                        unsigned uid = 0;
                        while (fgets(ligne, sizeof ligne, f)) {
                            if (sscanf(ligne, "Uid: %u", &uid) == 1) { break; }
                        }
                        fclose(f);
                        if (uid == getuid() + 1) {
                            snprintf(chemin, sizeof chemin, "/proc/%s/oom_score_adj", e->d_name);
                            trouve = lire_adj(chemin) == 500 ? 1 : -1;
                        }
                    }
                    if (d) { closedir(d); }
                    return trouve == 1;
                }

                int abaisse(int n) { return abaisser() < 1000 ? n * 2 : 0; }
                int memoire(int n) { abaisser(); remplir(2048); return n * 2; }
                int memoire_temoin(int n) { return remplir(64) == 64 ? n * 2 : 0; }
                /* Ordre des victimes, lu sur le vrai conteneur : superviseur jamais tué (-1000,
                   sans quoi une victime lente à mourir le laissait choisir), noteur ensuite. */
                int ordre(int n) {
                    return lire_adj("/proc/1/oom_score_adj") == -1000
                            && lire_adj("/proc/self/oom_score_adj") == 1000 && noteur_second()
                            ? n * 2 : 0;
                }
                int temoin(int n) { return n * 2; }
                """;
        List<TestResult> r = small.evaluate("C", probe, List.of(
                new TestCaseInput("abaissement", "return abaisse(5) == 10;", 1),
                new TestCaseInput("mémoire hors RSS", "return memoire(5) == 10;", 1),
                new TestCaseInput("témoin memfd", "return memoire_temoin(5) == 10;", 1),
                new TestCaseInput("témoin", "return temoin(5) == 10;", 1),
                new TestCaseInput("ordre des victimes", "return ordre(5) == 10;", 1)), null);
        assertThat(r.get(0).passed())
                .withFailMessage("le code soumis ne doit plus pouvoir abaisser son "
                        + "oom_score_adj : %s", r.get(0))
                .isFalse();
        assertThat(r.get(1).passed()).isFalse();
        // TÉMOINS : le chemin memfd fonctionne sous la limite (la sonde tourne vraiment), et le
        // conteneur a survécu à l'OOM — c'est le code soumis qui a été tué.
        assertThat(r.get(2).passed()).withFailMessage("témoin memfd : %s", r.get(2)).isTrue();
        assertThat(r.get(3).passed()).withFailMessage("témoin : %s", r.get(3)).isTrue();
        // Superviseur à -1000, code soumis à 1000, noteur à 500 : sans le -1000, une victime
        // lente à rendre sa mémoire (tables de pages) laissait l'OOM passer au superviseur — 2
        // courses sur 6 mesurées, trop aléatoire pour un test ; l'état, lui, se lit.
        assertThat(r.get(4).passed()).withFailMessage("ordre des victimes : %s", r.get(4)).isTrue();
    }

    @Test
    void record_locks_and_kernel_aio_are_refused_to_student_code() {
        require("C");
        // Un verrou fcntl est de la mémoire noyau que le cgroup ne compte PAS : 4 millions,
        // posés en 16 s, ajoutaient 872 Mo à l'HÔTE et rien au conteneur — de quoi faire
        // tomber le VPS de prod dans l'OOM global, qui tue alors le code soumis d'un AUTRE
        // étudiant. Le superviseur les refuse (ENOLCK) aux processus de l'UID étudiant par un
        // filtre seccomp ; flock() reste permis. Le même filtre refuse io_setup (ENOSYS) : la
        // limite de l'AIO noyau, fs.aio-max-nr, est GLOBALE — 128 contextes la vidaient pour
        // tous les conteneurs de l'hôte.
        String probe = """
                #define _GNU_SOURCE
                #include <errno.h>
                #include <fcntl.h>
                #include <linux/aio_abi.h>
                #include <stdio.h>
                #include <stdlib.h>
                #include <sys/file.h>
                #include <sys/syscall.h>
                #include <unistd.h>

                static int fichier(void) {
                    char chemin[512];
                    snprintf(chemin, sizeof chemin, "%s/verrou", getenv("TMPDIR"));
                    return open(chemin, O_RDWR | O_CREAT, 0600);
                }

                /* Réussit si le verrou a été POSÉ : le filtre est rompu. */
                static int poser(int commande) {
                    struct flock fl = {.l_type = F_WRLCK, .l_whence = SEEK_SET, .l_len = 1};
                    int fd = fichier();
                    return fd >= 0 && fcntl(fd, commande, &fl) == 0;
                }

                int posix(int n) { return poser(F_SETLK) ? n * 2 : 0; }
                int ofd(int n) { return poser(F_OFD_SETLK) ? n * 2 : 0; }

                /* Réussit si l'AIO noyau a répondu autre chose que ENOSYS. */
                int aio(int n) {
                    aio_context_t contexte = 0;
                    return syscall(SYS_io_setup, 1, &contexte) == 0 || errno != ENOSYS ? n * 2 : 0;
                }

                /* TÉMOIN : flock et F_GETLK, eux, restent permis — la sonde ouvre bien un
                   fichier et fcntl répond ; seule la pose d'un verrou d'enregistrement échoue. */
                int temoin(int n) {
                    struct flock q = {.l_type = F_WRLCK, .l_whence = SEEK_SET, .l_len = 1};
                    int fd = fichier();
                    return fd >= 0 && flock(fd, LOCK_EX) == 0 && fcntl(fd, F_GETLK, &q) == 0
                            ? n * 2 : 0;
                }

                /* UID étudiant tiré dans une plage large (≥ 2^24) : deux conteneurs simultanés
                   ne partagent plus leurs limites par UID que dans ~10^-8 des cas. */
                int uid(int n) { return getuid() >= (1u << 24) ? n * 2 : 0; }
                """;
        List<TestResult> r = evaluator.evaluate("C", probe, List.of(
                new TestCaseInput("F_SETLK", "return posix(5) == 10;", 1),
                new TestCaseInput("F_OFD_SETLK", "return ofd(5) == 10;", 1),
                new TestCaseInput("témoin", "return temoin(5) == 10;", 1),
                new TestCaseInput("UID", "return uid(5) == 10;", 1),
                new TestCaseInput("io_setup", "return aio(5) == 10;", 1)), null);
        assertThat(r.get(0).passed()).withFailMessage("F_SETLK doit être refusé : %s", r.get(0))
                .isFalse();
        assertThat(r.get(1).passed()).withFailMessage("F_OFD_SETLK doit être refusé : %s", r.get(1))
                .isFalse();
        assertThat(r.get(2).passed()).withFailMessage("témoin : %s", r.get(2)).isTrue();
        assertThat(r.get(3).passed()).withFailMessage("UID dans la plage large : %s", r.get(3))
                .isTrue();
        assertThat(r.get(4).passed()).withFailMessage("io_setup doit être refusé : %s", r.get(4))
                .isFalse();
    }

    @Test
    void student_compilation_is_done_once_per_job() {
        // Le programme étudiant ne dépend que du code soumis : il était pourtant recompilé à
        // CHAQUE cas, canaris compris. Une boucle d'évaluation constante en Rust (90 s, le
        // délai de compilation) tenait ainsi une place 451 s pour trois cas, sans rien changer
        // au verdict. Le superviseur compile une fois et rejoue : l'échec tel quel, la réussite
        // en recopiant le binaire (le dossier de classes en Java) dans le chantier du cas.
        // Erreur dans le CORPS : la fonction reste extractible, l'échec vient bien du compilateur.
        record Probe(String language, String code, String harness) { }
        List<Probe> probes = List.of(
                new Probe("C", "int doubler(int n) { return n * BON; }\n",
                        "return doubler(5) == 10;"),
                new Probe("C++", "int doubler(int n) { return n * BON; }\n",
                        "return doubler(5) == 10;"),
                new Probe("Rust", "fn doubler(n: i32) -> i32 { n * BON }\n",
                        "doubler(5) == 10"),
                new Probe("Go", "package main\n\nfunc doubler(n int) int { return n * BON }\n\n"
                        + "func main() {}\n", "return doubler(5) == 10"),
                new Probe("Java", "public class Solution {\n    public static int doubler(int n) "
                        + "{ return n * BON; }\n}\n", "return Solution.doubler(5) == 10;"),
                new Probe("C#", "public class Solution {\n    public static int doubler(int n) "
                        + "{ return n * BON; }\n}\n", "return Solution.doubler(5) == 10;"));
        JsonMapper mapper = JsonMapper.builder().build();
        for (Probe probe : probes) {
            require(probe.language());
            for (boolean compiles : new boolean[] {false, true}) {
                String code = probe.code().replace("BON", compiles ? "2" : "inconnue");
                String what = probe.language() + (compiles ? " (juste)" : " (erreur)");
                List<TestCaseInput> cases = List.of(new TestCaseInput("a", probe.harness(), 1),
                        new TestCaseInput("b", probe.harness(), 1),
                        new TestCaseInput("c", probe.harness(), 1));
                HarnessProjects.Project project =
                        HarnessProjects.build(probe.language(), code, cases, 10_000, 600_000L);
                DockerSandbox.ContainerRun run = evaluator.sandbox().run(
                        evaluator.imageFor(project.runnerLanguage()), project.files(), 900_000);
                JsonNode root = mapper.readTree(run.stdout());
                String expected = compiles ? "compilation_rejouee" : "echec_compilation_rejoue";
                long replays = 0;
                for (JsonNode event : root.path("events")) {
                    if (expected.equals(event.path("type").asString(""))) {
                        replays++;
                    }
                }
                // Trois cas réels + deux canaris : une seule vraie compilation, quatre rejouées.
                assertThat(replays).withFailMessage("%s : %d rejeux — %s", what, replays,
                        run.stdout()).isEqualTo(project.caseCount() + 2L - 1L);
                assertThat(root.path("results")).hasSize(3);
                for (JsonNode result : root.path("results")) {
                    if (compiles) {
                        // TÉMOIN : le binaire rejoué tourne et répond juste, canaris compris.
                        assertThat(result.path("passed").asBoolean(false))
                                .withFailMessage("%s : %s", what, result).isTrue();
                    } else {
                        // TÉMOIN : le compilateur a bien tourné, et son diagnostic est rendu
                        // à CHAQUE cas, rejoué compris.
                        assertThat(result.path("passed").asBoolean(true)).isFalse();
                        assertThat(result.path("detail").asString(""))
                                .withFailMessage("%s : diagnostic absent — %s", what, result)
                                .contains("Échec de compilation").contains("inconnue");
                    }
                }
                if (compiles) {
                    assertThat(root.path("canaries").asString("")).isEqualTo("ok");
                }
            }
        }
    }

    @Test
    void execution_from_tmp_refused_for_student_code() {
        require("Go");
        // /tmp est monté noexec : un binaire déposé par l'UID étudiant ne peut pas être exécuté
        // (seul /box, qui porte les programmes compilés, est exec). Tout échec de MISE EN PLACE
        // de la sonde renvoie la bonne réponse, pour que le test échoue au lieu de passer à vide.
        String probe = """
                package main

                import (
                    "os"
                    "os/exec"
                )

                func doubler(n int) int {
                    sh, err := os.ReadFile("/bin/sh")
                    if err != nil {
                        return n * 2 // sonde impossible : on ne conclut pas
                    }
                    if err := os.WriteFile("/tmp/moodit_exec_probe", sh, 0o700); err != nil {
                        return n * 2 // sonde impossible : on ne conclut pas
                    }
                    if err := exec.Command("/tmp/moodit_exec_probe", "-c", "exit 0").Run();
                            err == nil {
                        return n * 2 // exécution depuis /tmp obtenue : noexec est rompu
                    }
                    return 0
                }

                // TÉMOIN POSITIF : la même sonde, déposée dans $TMPDIR (sous /box, exec), DOIT
                // s'exécuter. Sans lui, une régression qui interdirait TOUT exec au code soumis
                // laisserait le premier cas vert sans plus rien mesurer de noexec.
                func ailleurs(n int) int {
                    sh, err := os.ReadFile("/bin/sh")
                    if err != nil {
                        return 0
                    }
                    path := os.Getenv("TMPDIR") + "/moodit_exec_probe"
                    if err := os.WriteFile(path, sh, 0o700); err != nil {
                        return 0
                    }
                    if err := exec.Command(path, "-c", "exit 0").Run(); err != nil {
                        return 0
                    }
                    return n * 2
                }

                // TÉMOIN, comme pour la sonde réseau : un programme qui ne compile plus rend
                // lui aussi un cas faux.
                func temoin(n int) int { return n * 2 }

                func main() {}
                """;
        List<TestResult> r = evaluator.evaluate("Go", probe, List.of(
                new TestCaseInput("exécution depuis /tmp", GO_HARNESS, 1),
                new TestCaseInput("témoin", "return temoin(5) == 10", 1),
                new TestCaseInput("exécution depuis $TMPDIR", "return ailleurs(5) == 10", 1)), null);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(2).passed())
                .withFailMessage("la même sonde doit s'exécuter hors de /tmp, sinon le refus "
                        + "ne prouve rien de noexec : %s", r.get(2))
                .isTrue();
        assertThat(r.get(1).passed())
                .withFailMessage("le témoin doit réussir, sinon la sonde noexec ne prouve rien "
                        + "(le programme n'a pas compilé ou n'a pas tourné) : %s", r.get(1))
                .isTrue();
    }

    // ─────────────────────────── Budgets et robustesse ───────────────────────────

    @Test
    void infinite_loop_is_interrupted() {
        require("Go");
        String infiniteLoop = "package main\n\nfunc doubler(n int) int { for {} }\n\nfunc main() {}\n";
        List<TestResult> r = evaluator.evaluate("Go", infiniteLoop,
                List.of(new TestCaseInput("t", GO_HARNESS, 1)), 2000);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(0).detail()).contains("Interrompu");
    }

    @Test
    void interrupted_run_leaves_no_container() throws Exception {
        require("Go");
        // Arrêt du service pendant une notation : le fil est interrompu, et le conteneur doit
        // être SUPPRIMÉ. Rétabli avant le `finally`, le drapeau d'interruption faisait échouer
        // l'appel de suppression au démon : le conteneur restait vivant jusqu'à son mur, puis
        // en « Exited » jusqu'au balayage. Un mock ne le voit pas (son `exec()` réussit
        // toujours) : seul un vrai démon le montre.
        // N'agit que sur le conteneur de CE sandbox : sur un démon partagé (pile e2e, autre suite
        // de tests), « tout conteneur runner apparu depuis » désignait aussi ceux des autres, et
        // le nettoyage les supprimait en pleine notation.
        String infiniteLoop = "package main\n\nfunc doubler(n int) int { for {} }\n\nfunc main() {}\n";
        java.util.Set<String> mine = new java.util.HashSet<>();
        var thrown = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        Thread worker = new Thread(() -> {
            try {
                evaluator.evaluate("Go", infiniteLoop,
                        List.of(new TestCaseInput("t", GO_HARNESS, 1)), 60_000);
            } catch (Throwable e) {
                thrown.set(e);
            }
        });
        worker.start();
        try {
            java.util.Set<String> created = java.util.Set.of();
            long deadline = System.nanoTime() + java.time.Duration.ofSeconds(60).toNanos();
            while (created.isEmpty() && System.nanoTime() < deadline) {
                Thread.sleep(250);
                created = sandbox.inFlightContainers();
            }
            assertThat(created).as("le conteneur de notation doit avoir démarré").isNotEmpty();
            mine.addAll(created);
            Thread.sleep(2000);   // en pleine attente du conteneur, pas pendant sa création
            worker.interrupt();
            worker.join(java.time.Duration.ofSeconds(60).toMillis());
            assertThat(worker.isAlive()).as("la notation interrompue doit rendre la main").isFalse();
            assertThat(thrown.get()).isInstanceOf(SandboxException.class);
            java.util.Set<String> remaining = new java.util.HashSet<>(runnerContainers());
            remaining.retainAll(mine);
            assertThat(remaining)
                    .as("aucun conteneur de cette notation ne doit rester, même arrêté")
                    .isEmpty();
        } finally {
            worker.interrupt();
            java.util.Set<String> left = new java.util.HashSet<>(runnerContainers());
            left.retainAll(mine);
            for (String id : left) {   // ne rien laisser derrière un test en échec — les siens seuls
                new ProcessBuilder("docker", "rm", "-f", id).inheritIO().start().waitFor();
            }
        }
    }

    /** Conteneurs runner (étiquette de {@link DockerSandbox}), arrêtés compris. */
    private static java.util.Set<String> runnerContainers() throws Exception {
        Process ps = new ProcessBuilder("docker", "ps", "-a", "-q", "--no-trunc",
                "--filter", "label=" + DockerSandbox.RUNNER_LABEL + "=1")
                .redirectErrorStream(true).start();
        String out = new String(ps.getInputStream().readAllBytes(),
                java.nio.charset.StandardCharsets.UTF_8);
        assertThat(ps.waitFor()).as("docker ps : %s", out).isZero();
        return out.lines().map(String::trim).filter(l -> !l.isEmpty())
                .collect(java.util.stream.Collectors.toSet());
    }

    @Test
    void full_workspace_is_named_as_the_cause() {
        require("C");
        // Le code remplit /box (son TMPDIR) puis rend la BONNE valeur : le noteur ne peut plus
        // écrire son jeton, et sort en 0 sans lui. Le cas reste en échec, mais le détail doit
        // nommer la saturation — il disait « Le harnais a renvoyé faux », et envoyait chercher
        // un bogue de logique inexistant.
        String filler = """
                #include <stdio.h>
                #include <stdlib.h>
                #include <string.h>

                // Fichiers de 30 Mo : sous la borne de taille d'un fichier du processus soumis.
                static void remplir(const char *dossier) {
                    static char bloc[1 << 20];
                    char chemin[4096];
                    if (!dossier) return;
                    memset(bloc, 'x', sizeof bloc);
                    for (int i = 0; i < 100000; i++) {
                        snprintf(chemin, sizeof chemin, "%s/plein%d", dossier, i);
                        FILE *f = fopen(chemin, "w");
                        if (!f) break;
                        int ok = 1;
                        for (int k = 0; k < 30 && ok; k++) {
                            ok = fwrite(bloc, 1, sizeof bloc, f) == sizeof bloc;
                        }
                        if (fclose(f) != 0 || !ok) break;
                    }
                }

                int doubler(int n) {
                    remplir(getenv("TMPDIR"));
                    remplir("/tmp");
                    remplir("/dev/shm");
                    return n * 2;
                }
                """;
        List<TestResult> r = evaluator.evaluate("C", filler,
                List.of(new TestCaseInput("t", "return doubler(5) == 10;", 1)), null);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(0).detail()).contains("Espace de travail saturé");
    }

    @Test
    void compilation_error_is_explained() {
        require("Go");
        String broken = "package main\n\nfunc doubler(n int) int { return n *\n";
        List<TestResult> r = evaluate("Go", broken, GO_HARNESS);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(0).detail()).contains("compilation");
    }

    @Test
    void public_tester_really_grades_cases() {
        require("Go");
        // Chemin PUBLIC (« Tester » du prof), DEUX cas, temps limite 60 s — la valeur maximale
        // de l'éditeur. Avec un budget dérivé du pire cas théorique, il tombait à 1 s : seul le
        // premier élément de la liste mélangée partait (parfois un canari), et tout le reste
        // répondait « Non exécuté : budget de notation dépassé ». Un seul cas au timeout par
        // défaut passait encore — c'est pour ça que la première version de ce test était verte.
        List<TestResult> r = evaluator.evaluate("Go", GO_OK,
                List.of(new TestCaseInput("doubler", GO_HARNESS, 1),
                        new TestCaseInput("doubler zéro", "return doubler(0) == 0", 1)),
                60_000, DockerEvaluator.PUBLIC_WALL_MS);
        assertThat(r.get(0).passed()).withFailMessage("cas 1 : %s", r.get(0)).isTrue();
        assertThat(r.get(1).passed()).withFailMessage("cas 2 : %s", r.get(1)).isTrue();
        assertThat(r.get(0).detail()).isNull();
    }

    @Test
    void java_short_time_limit_vm_floor() {
        require("Java");
        // 1 s de temps limite — valeur légitime pour un doubler : sans plancher, la JVM froide
        // tuait tous les cas et une simple configuration faisait échouer une réponse juste. Le
        // plancher VM (10 s, symétrique du mode exec) doit la laisser passer, sans alerte.
        List<TestResult> r = evaluator.evaluate("Java",
                "public class Solution { static int doubler(int n) { return n * 2; } }",
                List.of(new TestCaseInput("doubler", "return Solution.doubler(5) == 10;", 1)),
                1_000);
        assertThat(r.get(0).passed())
                .as("detail = " + r.get(0).detail())
                .isTrue();
        assertThat(r.get(0).detail()).isNull();
    }

    @Test
    void case_weights_returned_as_is() {
        require("C");
        List<TestResult> r = evaluator.evaluate("C",
                "int doubler(int n) { return n * 2; }",
                List.of(new TestCaseInput("juste", "return doubler(5) == 10;", 3),
                        new TestCaseInput("faux", "return doubler(5) == 11;", 2)), null);
        assertThat(r).hasSize(2);
        assertThat(r.get(0).passed()).isTrue();
        assertThat(r.get(0).weight()).isEqualTo(3);
        assertThat(r.get(1).passed()).isFalse();
        assertThat(r.get(1).weight()).isEqualTo(2);
    }
}
