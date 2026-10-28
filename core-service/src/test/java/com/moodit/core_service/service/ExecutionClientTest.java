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
 * l'ordre des harnais, {@code null} en cas de panne, et délai de lecture proportionnel au nombre de
 * harnais (#31). Mini serveur HTTP (JDK) en guise d'execution-service.
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

    private static ExecutionClient client(String url, long baseMs, long perTestMs) {
        return new ExecutionClient(url, TOKEN, 2_000, baseMs, perTestMs);
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
    @DisplayName("Délai de lecture = base + nombre de harnais × délai par harnais (au moins un)")
    void readTimeout_proportionnelAuNombreDeHarnais() {
        ExecutionClient client = client("http://localhost:1", 10_000, 20_000);

        assertThat(client.readTimeoutMs(1)).isEqualTo(30_000);
        assertThat(client.readTimeoutMs(5)).isEqualTo(110_000);
        assertThat(client.readTimeoutMs(100)).isEqualTo(2_010_000);
        assertThat(client.readTimeoutMs(0)).isEqualTo(30_000);
    }
}
