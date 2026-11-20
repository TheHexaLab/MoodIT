package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import org.junit.jupiter.api.Test;

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

    private final DockerEvaluator evaluator = new DockerEvaluator(
            new DockerSandbox("", 1536, 512, 2.0), "moodit-runner-",
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
        assertThat(r.get(4).passed())
                .withFailMessage("le témoin, noté APRÈS les sondes, doit réussir : le conteneur a "
                        + "survécu et le programme compile : %s", r.get(4))
                .isTrue();
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

                // TÉMOIN, comme pour la sonde réseau : un programme qui ne compile plus rend
                // lui aussi un cas faux.
                func temoin(n int) int { return n * 2 }

                func main() {}
                """;
        List<TestResult> r = evaluator.evaluate("Go", probe, List.of(
                new TestCaseInput("exécution depuis /tmp", GO_HARNESS, 1),
                new TestCaseInput("témoin", "return temoin(5) == 10", 1)), null);
        assertThat(r.get(0).passed()).isFalse();
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
        java.util.Set<String> before = runnerContainers();
        String infiniteLoop = "package main\n\nfunc doubler(n int) int { for {} }\n\nfunc main() {}\n";
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
                created = newSince(before);
            }
            assertThat(created).as("le conteneur de notation doit avoir démarré").isNotEmpty();
            Thread.sleep(2000);   // en pleine attente du conteneur, pas pendant sa création
            worker.interrupt();
            worker.join(java.time.Duration.ofSeconds(60).toMillis());
            assertThat(worker.isAlive()).as("la notation interrompue doit rendre la main").isFalse();
            assertThat(thrown.get()).isInstanceOf(SandboxException.class);
            assertThat(newSince(before))
                    .as("aucun conteneur de cette notation ne doit rester, même arrêté")
                    .isEmpty();
        } finally {
            worker.interrupt();
            for (String id : newSince(before)) {   // ne rien laisser derrière un test en échec
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

    private static java.util.Set<String> newSince(java.util.Set<String> before) throws Exception {
        java.util.Set<String> now = new java.util.HashSet<>(runnerContainers());
        now.removeAll(before);
        return now;
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
