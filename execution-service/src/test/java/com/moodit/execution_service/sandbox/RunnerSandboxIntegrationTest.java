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
    void sortie_reseau_refusee_depuis_le_code_etudiant() {
        require("Go");
        // --network none : aucune interface hors loopback, donc connect() échoue IMMÉDIATEMENT
        // (réseau inatteignable) — aucune dépendance à un hôte externe, aucune attente. Sans
        // cette garantie, le code soumis exfiltrerait sa réponse ou le nonce depuis le VPS.
        String sonde = """
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
        List<TestResult> r = evaluator.evaluate("Go", sonde, List.of(
                new TestCaseInput("réseau", GO_HARNESS, 1),
                new TestCaseInput("témoin", "return temoin(5) == 10", 1)), null);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(1).passed())
                .withFailMessage("le témoin doit réussir, sinon la sonde réseau ne prouve rien "
                        + "(le programme n'a pas compilé ou n'a pas tourné) : %s", r.get(1))
                .isTrue();
    }

    @Test
    void execution_depuis_tmp_refusee_depuis_le_code_etudiant() {
        require("Go");
        // /tmp est monté noexec : un binaire déposé par l'UID étudiant ne peut pas être exécuté
        // (seul /box, qui porte les programmes compilés, est exec). Tout échec de MISE EN PLACE
        // de la sonde renvoie la bonne réponse, pour que le test échoue au lieu de passer à vide.
        String sonde = """
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

                func main() {}
                """;
        assertThat(evaluate("Go", sonde, GO_HARNESS).get(0).passed()).isFalse();
    }

    // ─────────────────────────── Budgets et robustesse ───────────────────────────

    @Test
    void boucle_infinie_interrompue() {
        require("Go");
        String infini = "package main\n\nfunc doubler(n int) int { for {} }\n\nfunc main() {}\n";
        List<TestResult> r = evaluator.evaluate("Go", infini,
                List.of(new TestCaseInput("t", GO_HARNESS, 1)), 2000);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(0).detail()).contains("Interrompu");
    }

    @Test
    void erreur_de_compilation_expliquee() {
        require("Go");
        String casse = "package main\n\nfunc doubler(n int) int { return n *\n";
        List<TestResult> r = evaluate("Go", casse, GO_HARNESS);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(0).detail()).contains("compilation");
    }

    @Test
    void tester_public_note_vraiment_les_cas() {
        require("Go");
        // Chemin PUBLIC (« Tester » du prof) : mur plafonné à PUBLIC_WALL_MS. Aucun test ne
        // l'empruntait, et une réserve de budget mal bornée y faisait répondre « Non exécuté :
        // budget de notation dépassé » sur TOUS les cas des six langages compilés.
        List<TestResult> r = evaluator.evaluate("Go", GO_OK,
                List.of(new TestCaseInput("doubler", GO_HARNESS, 1)), null,
                DockerEvaluator.PUBLIC_WALL_MS);
        assertThat(r.get(0).passed()).isTrue();
        assertThat(r.get(0).detail()).isNull();
    }

    @Test
    void java_temps_limite_court_plancher_vm() {
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
    void poids_des_cas_rendus_tels_quels() {
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
