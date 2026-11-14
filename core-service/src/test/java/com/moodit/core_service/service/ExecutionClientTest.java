package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Client de correction (execution-service, endpoint interne) : appel avec le jeton, verdicts dans
 * l'ordre des harnais, {@code null} en cas de panne, et délai de lecture proportionnel au nombre
 * d'appels au sandbox, attente d'une place comprise (#31, #216). Mini serveur HTTP (JDK) en guise
 * d'execution-service.
 */
class ExecutionClientTest {

    private static final String TOKEN = "jeton-interne-de-test";
    private static final List<ExecutionClient.Harness> TWO_HARNESSES = List.of(
            new ExecutionClient.Harness("cas A", "assert A", 2),
            new ExecutionClient.Harness("cas B", "assert B", 1));

    private HttpServer server;
    private final AtomicReference<String> receivedToken = new AtomicReference<>();
    private final AtomicReference<String> receivedPath = new AtomicReference<>();
    private final AtomicReference<String> receivedBody = new AtomicReference<>();

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    /** Stub de /internal/exec/evaluate : répond (status, body) après {@code delayMs}. */
    private String startStub(int status, String body, long delayMs) throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/internal/exec", exchange -> {
            receivedPath.set(exchange.getRequestURI().getPath());
            receivedToken.set(exchange.getRequestHeaders().getFirst("X-Internal-Token"));
            receivedBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            try {
                Thread.sleep(delayMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            } catch (IOException ignored) {
                // client déjà parti (délai dépassé)
            }
            exchange.close();
        });
        server.start();
        return "http://localhost:" + server.getAddress().getPort();
    }

    /** Client sans attente d'une place : le délai par appel se réduit à {@code perTestMs}. */
    private static ExecutionClient client(String url, long baseMs, long perTestMs) {
        return client(url, baseMs, perTestMs, 0);
    }

    private static ExecutionClient client(String url, long baseMs, long perTestMs, long queueWaitMs) {
        return new ExecutionClient(url, TOKEN, 2_000, baseMs, perTestMs, queueWaitMs);
    }

    @Test
    @DisplayName("Verdicts renvoyés dans l'ordre des harnais, jeton interne envoyé")
    void evaluate_renvoieLesVerdictsDansLOrdre() throws Exception {
        String url = startStub(200,
                "[{\"name\":\"cas A\",\"weight\":2,\"passed\":true,\"detail\":null},"
                        + "{\"name\":\"cas B\",\"weight\":1,\"passed\":false,\"detail\":\"x\"}]", 0);

        List<Boolean> verdicts = client(url, 2_000, 2_000).evaluate("Python", "code", TWO_HARNESSES);

        assertThat(verdicts).containsExactly(true, false);
        assertThat(receivedPath.get()).isEqualTo("/internal/exec/evaluate");
        assertThat(receivedToken.get()).isEqualTo(TOKEN);
    }

    @Test
    @DisplayName("Erreur HTTP ou service injoignable → null")
    void evaluate_panne_null() throws Exception {
        String url = startStub(500, "{}", 0);
        assertThat(client(url, 2_000, 2_000).evaluate("Python", "code", TWO_HARNESSES)).isNull();

        server.stop(0);
        server = null;
        assertThat(client(url, 2_000, 2_000).evaluate("Python", "code", TWO_HARNESSES)).isNull();
    }

    @Test
    @DisplayName("Corps vide → null")
    void evaluate_corpsVide_null() throws Exception {
        String url = startStub(200, "", 0);

        assertThat(client(url, 2_000, 2_000).evaluate(null, null, TWO_HARNESSES)).isNull();
    }

    @Test
    @DisplayName("Même avec des réglages minuscules, le budget couvre le mur du runner")
    void readTimeout_plancherDuMurDuRunner() {
        // Depuis le runner (#116), chaque unité exec peut légitimement durer jusqu'à son mur
        // (75 s) : des réglages trop bas ne doivent plus pouvoir produire un budget qui
        // abandonne une correction en cours (#216). Un stub « plus lent que le budget » est
        // donc devenu inconstructible à l'échelle d'un test unitaire — le chemin « échec
        // d'appel → null » reste couvert par le test du sandbox injoignable.
        ExecutionClient client = client("http://localhost:1", 1, 1, 1);
        assertThat(client.readTimeoutMs("Python", 1, null)).isGreaterThanOrEqualTo(75_000);
        assertThat(client.readTimeoutMs("Java", 4, null))
                .isGreaterThanOrEqualTo(30_000 + 3 * 100_000);
    }

    @Test
    @DisplayName("Réponse lente mais dans le délai calculé pour ses harnais → verdicts")
    void evaluate_reponseLenteDansLeDelai_verdicts() throws Exception {
        String url = startStub(200,
                "[{\"name\":\"cas A\",\"weight\":2,\"passed\":true,\"detail\":null},"
                        + "{\"name\":\"cas B\",\"weight\":1,\"passed\":true,\"detail\":null}]", 400);

        // 2 harnais : 100 + 2 × 300 = 700 ms > 400 ms ; un délai fixe de 300 ms aurait échoué.
        assertThat(client(url, 100, 300).evaluate("Python", "code", TWO_HARNESSES))
                .containsExactly(true, true);
    }

    @Test
    @DisplayName("Délai de lecture = base + nombre d'appels × (attente d'une place + exécution), au moins un")
    void readTimeout_couvreAttenteEtAppelParHarnais() {
        // Valeurs par défaut : 10 s de base, per-test-timeout-ms = 20 s, EXEC_INTERNAL_QUEUE_WAIT_MS = 15 s.
        ExecutionClient client = client("http://localhost:1", 10_000, 20_000, 15_000);

        // Par unité : attente de file (15 s) + max(20 s, temps limite + 5 s) + 75 s de mur
        // du runner (miroir de WALL_OVERHEAD_MS) + 35 s de cycle de vie du conteneur
        // (création, copie, démarrage, collecte des logs — hors mur côté serveur).
        assertThat(client.readTimeoutMs("Python", 1, null)).isEqualTo(10_000 + 145_000);
        assertThat(client.readTimeoutMs("Python", 5, null)).isEqualTo(10_000 + 5 * 145_000);
        assertThat(client.readTimeoutMs("Python", 0, null)).isEqualTo(10_000 + 145_000);
    }

    @Test
    @DisplayName("Le temps limite de la question entre dans le budget par unité dès qu'il dépasse le défaut")
    void readTimeout_integreLeTempsLimiteDeLaQuestion() {
        ExecutionClient client = client("http://localhost:1", 10_000, 20_000, 15_000);

        // 60 s de temps limite : chaque unité attend 60 s + 5 s de marge (> 20 s par défaut).
        assertThat(client.readTimeoutMs("Python", 1, 60_000))
                .isEqualTo(10_000 + (65_000 + 75_000 + 35_000 + 15_000));
        // Sous le défaut (10 s + 5 s < 20 s) : le plancher par défaut de l'unité reste.
        assertThat(client.readTimeoutMs("Python", 1, 5_000)).isEqualTo(10_000 + 145_000);
        // Compilé : UNE attente de file + miroir du mur de DockerEvaluator — 30 s de base +
        // (N + 2 canaris) × (run + 10 s de marge + les COMPILATIONS du cas + 5 s d'inventaire
        // `--list`). 4 unités = 1 harnais → 3 cas. La formule est écrite TERME À TERME : tout
        // terme ajouté au perCase serveur doit apparaître ici, sinon le miroir est plus court
        // que le mur réel et le read timeout expire pendant une notation en cours (#216).
        // TROIS compilations par cas en Java (chemin non falsifiable : code soumis seul pour
        // lire ses signatures, puis noteur, puis serveur), DEUX ailleurs ; le pire cas est pris
        // sans regarder la forme des harnais — surestimer fait attendre, sous-estimer casse.
        // 30 s + 3 × (60 + 10 + 3 × 90 + 5) = 1065 s : au-delà du mur du serveur (15 min), donc
        // PLAFONNÉ — comme le mur lui-même. Trois compilations par cas coûtent cher, et une
        // question Java à plusieurs cas lents sera notée partiellement (verdicts « Non évalué »,
        // comportement dégradé documenté), jamais tuée au mur.
        assertThat(client.readTimeoutMs("Java", 4, 60_000))
                .isEqualTo(10_000 + 15_000 + 15 * 60_000 + 5_000 + 35_000);
        // Plancher VM (10 s) : un temps limite court sur Java ne sous-budgète pas la JVM froide.
        // 30 s + 3 × (10 + 10 + 270 + 5) = 915 s : plafonné de justesse.
        assertThat(client.readTimeoutMs("Java", 4, 1_000))
                .isEqualTo(10_000 + 15_000 + 15 * 60_000 + 5_000 + 35_000);
        // Go : DEUX compilations par cas, et non trois — 795 s, sous le plafond.
        assertThat(client.readTimeoutMs("Go", 4, 60_000))
                .isEqualTo(10_000 + 15_000 + 30_000
                        + 3 * (60_000 + 10_000 + 2 * 90_000 + 5_000) + 5_000 + 35_000);
        // Plafonné par le mur du serveur (15 min) : 100 harnais ne donnent plus ~3 h.
        assertThat(client.readTimeoutMs("Java", 202, 60_000))
                .isEqualTo(10_000 + 15_000 + 15 * 60_000 + 5_000 + 35_000);
        // TypeScript : unité exec ordinaire — les 75 s de mur couvrent la transpilation (60 s).
        assertThat(client.readTimeoutMs("TypeScript", 2, null))
                .isEqualTo(10_000 + 2 * 145_000);
    }

    @Test
    @DisplayName("Interprété : le budget est plafonné par celui du serveur, dépassement d'un harnais compris")
    void readTimeout_plafonneParLeBudgetDuServeur() {
        ExecutionClient client = client("http://localhost:1", 10_000, 20_000, 15_000);

        // Symétrique du plafond compilé : le chemin interprété lance un conteneur PAR unité, donc
        // son budget croissait linéairement (100 harnais Python ≈ 7 h avec les défauts de prod).
        // execution-service borne désormais la boucle (app.exec.interpreted-budget-ms, 15 min) :
        // au-delà, les harnais restants ne sont plus lancés. Le client plafonne au même budget,
        // PLUS une unité — l'échéance est consultée avant chaque harnais, donc celui qui vient de
        // partir va au bout ; sans ce terme, core renoncerait avant le serveur (#216).
        long perUnit = 145_000;
        assertThat(client.readTimeoutMs("Python", 100, null))
                .isEqualTo(10_000 + 15 * 60_000 + perUnit);
        // SQL : deux unités par harnais (phases isolées), donc deux unités de dépassement.
        assertThat(client.readTimeoutMs("sql", 200, null))
                .isEqualTo(10_000 + 15 * 60_000 + 2 * perUnit);
        // Sous le budget, rien ne change : la formule par unité reste la référence.
        assertThat(client.readTimeoutMs("Python", 5, null)).isEqualTo(10_000 + 5 * perUnit);
        // Bascule : le plafond ne mord qu'au-delà de (budget + 1 unité) / unité ≈ 7,2 unités.
        assertThat(client.readTimeoutMs("Python", 7, null)).isEqualTo(10_000 + 7 * perUnit);
        assertThat(client.readTimeoutMs("Python", 8, null))
                .isEqualTo(10_000 + 15 * 60_000 + perUnit);
    }

    @Test
    @DisplayName("Le budget serveur surchargé est suivi par le miroir client (même variable d'environnement)")
    void readTimeout_suitLeBudgetServeurSurcharge() {
        // Le budget est lu dans la MÊME variable qu'execution-service (EXEC_INTERPRETED_BUDGET_MS) :
        // un plafond client figé devenait trop COURT dès qu'on relevait le budget serveur, et core
        // abandonnait une correction encore en cours — exactement le bug de #216. Ici 30 min.
        ExecutionClient relache = new ExecutionClient("http://localhost:1", TOKEN, 2_000,
                10_000, 20_000, 15_000, 30 * 60_000);
        assertThat(relache.readTimeoutMs("Python", 100, null))
                .isEqualTo(10_000 + 30 * 60_000 + 145_000);
        // Et un budget serveur ABAISSÉ raccourcit le miroir d'autant (5 min).
        ExecutionClient serre = new ExecutionClient("http://localhost:1", TOKEN, 2_000,
                10_000, 20_000, 15_000, 5 * 60_000);
        assertThat(serre.readTimeoutMs("Python", 100, null))
                .isEqualTo(10_000 + 5 * 60_000 + 145_000);
    }

    @Test
    @DisplayName("compiled() et transpiled() reconnaissent les familles de langages")
    void compiled_reconnaitLesLangagesCompiles() {
        assertThat(ExecutionClient.compiled("Java")).isTrue();
        assertThat(ExecutionClient.compiled(" c++ ")).isTrue();
        assertThat(ExecutionClient.compiled("go")).isTrue();
        assertThat(ExecutionClient.compiled("Python")).isFalse();
        assertThat(ExecutionClient.compiled("sql")).isFalse();
        assertThat(ExecutionClient.compiled(null)).isFalse();
        assertThat(ExecutionClient.vmLanguage("Java")).isTrue();
        assertThat(ExecutionClient.vmLanguage("C#")).isTrue();
        assertThat(ExecutionClient.vmLanguage("go")).isFalse();
        assertThat(ExecutionClient.vmLanguage(null)).isFalse();
    }

    @Test
    @DisplayName("Le temps limite de la question part dans le corps HTTP (timeoutMs), replafonné")
    void evaluate_envoieLeTimeoutDansLeCorps() throws IOException {
        String url = startStub(200,
                "[{\"name\":\"cas A\",\"weight\":2,\"passed\":true,\"detail\":null},"
                        + "{\"name\":\"cas B\",\"weight\":1,\"passed\":true,\"detail\":null}]", 0);
        ExecutionClient client = client(url, 10_000, 20_000, 15_000);

        client.evaluate("Python", "code", TWO_HARNESSES, 30_000);
        assertThat(receivedBody.get()).contains("\"timeoutMs\":30000");

        client.evaluate("Python", "code", TWO_HARNESSES, 999_999);
        assertThat(receivedBody.get()).contains("\"timeoutMs\":60000");

        client.evaluate("Python", "code", TWO_HARNESSES, -5);
        assertThat(receivedBody.get()).doesNotContain("timeoutMs");
    }

    @Test
    @DisplayName("Un harnais SQL compte pour deux appels (exécution en deux phases), les autres pour un")
    void workUnits_sqlEnDeuxPhases() {
        assertThat(ExecutionClient.workUnits("Python", 3)).isEqualTo(3);
        assertThat(ExecutionClient.workUnits(null, 3)).isEqualTo(3);
        assertThat(ExecutionClient.workUnits("sql", 3)).isEqualTo(6);
        assertThat(ExecutionClient.workUnits(" SQL ", 1)).isEqualTo(2);
        assertThat(ExecutionClient.workUnits("sqlite", 2)).isEqualTo(4);
        assertThat(ExecutionClient.workUnits("sqlite3", 2)).isEqualTo(4);
        assertThat(ExecutionClient.workUnits("sqlserver", 2)).isEqualTo(2);
        // Compilés (#116) : compilation + exécution par cas, plus deux canaris du runner.
        assertThat(ExecutionClient.workUnits("Java", 3)).isEqualTo(8);
        assertThat(ExecutionClient.workUnits("C++", 1)).isEqualTo(4);
        assertThat(ExecutionClient.workUnits("go", 2)).isEqualTo(6);
    }

    @Test
    @DisplayName("Réponse retardée par l'attente d'une place mais dans le budget → verdicts")
    void evaluate_attenteDUnePlaceDansLeBudget_verdicts() throws Exception {
        String url = startStub(200,
                "[{\"name\":\"cas A\",\"weight\":2,\"passed\":true,\"detail\":null},"
                        + "{\"name\":\"cas B\",\"weight\":1,\"passed\":true,\"detail\":null}]", 800);

        // 2 harnais : 100 + 2 × (200 + 300) = 1,1 s > 800 ms ; sans l'attente, 100 + 2 × 200 = 500 ms.
        assertThat(client(url, 100, 200, 300).evaluate("Python", "code", TWO_HARNESSES))
                .containsExactly(true, true);
    }

    @Test
    @DisplayName("Harnais SQL : le délai compte ses deux appels au sandbox")
    void evaluate_sqlDeuxPhasesDansLeDelai_verdicts() throws Exception {
        String url = startStub(200,
                "[{\"name\":\"cas A\",\"weight\":2,\"passed\":true,\"detail\":null},"
                        + "{\"name\":\"cas B\",\"weight\":1,\"passed\":false,\"detail\":\"x\"}]", 800);

        // 2 harnais SQL = 4 appels : 100 + 4 × 250 = 1,1 s > 800 ms ; comptés comme 2 appels, 600 ms.
        assertThat(client(url, 100, 250).evaluate("sql", "code", TWO_HARNESSES))
                .containsExactly(true, false);
    }
}
