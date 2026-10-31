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
            exchange.getRequestBody().readAllBytes();
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
    @DisplayName("Réponse plus lente que le délai calculé → null")
    void evaluate_reponseTropLente_null() throws Exception {
        String url = startStub(200, "[]", 1_500);

        // 2 harnais : 100 + 2 × 100 = 300 ms < 1,5 s.
        assertThat(client(url, 100, 100).evaluate("Python", "code", TWO_HARNESSES)).isNull();
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
    @DisplayName("Délai de lecture = base + nombre d'appels × (attente d'une place + appel Piston), au moins un")
    void readTimeout_couvreAttenteEtAppelParHarnais() {
        // Valeurs par défaut : 10 s de base, PISTON_HTTP_TIMEOUT_MS = 20 s, EXEC_INTERNAL_QUEUE_WAIT_MS = 15 s.
        ExecutionClient client = client("http://localhost:1", 10_000, 20_000, 15_000);

        assertThat(client.readTimeoutMs(1)).isEqualTo(45_000);
        assertThat(client.readTimeoutMs(5)).isEqualTo(185_000);
        assertThat(client.readTimeoutMs(100)).isEqualTo(3_510_000);
        assertThat(client.readTimeoutMs(0)).isEqualTo(45_000);
    }

    @Test
    @DisplayName("Un harnais SQL compte pour deux appels (exécution en deux phases), les autres pour un")
    void pistonCalls_sqlEnDeuxPhases() {
        assertThat(ExecutionClient.pistonCalls("Python", 3)).isEqualTo(3);
        assertThat(ExecutionClient.pistonCalls(null, 3)).isEqualTo(3);
        assertThat(ExecutionClient.pistonCalls("sql", 3)).isEqualTo(6);
        assertThat(ExecutionClient.pistonCalls(" SQL ", 1)).isEqualTo(2);
        assertThat(ExecutionClient.pistonCalls("sqlite", 2)).isEqualTo(4);
        assertThat(ExecutionClient.pistonCalls("sqlite3", 2)).isEqualTo(4);
        assertThat(ExecutionClient.pistonCalls("sqlserver", 2)).isEqualTo(2);
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
