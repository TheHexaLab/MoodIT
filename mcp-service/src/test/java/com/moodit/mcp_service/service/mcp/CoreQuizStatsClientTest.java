package com.moodit.mcp_service.service.mcp;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Client de la réussite aux quiz (endpoint interne de core-service). On vérifie l'URL appelée,
 * l'en-tête {@code X-Internal-Token}, l'extraction de {@code averageScorePercent} et surtout la
 * traduction des pannes en {@code null} (« non disponible » pour le LLM / le repli) : une panne
 * de core ne doit jamais faire échouer l'analyse. Mini serveur HTTP (JDK) en guise de core.
 */
class CoreQuizStatsClientTest {

    private static final String TOKEN = "jeton-interne-de-test";

    private record Received(String method, String path, String token) {}

    private final List<Received> received = new CopyOnWriteArrayList<>();
    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    /** Stub de /internal/quiz-stats/** qui renvoie (status, body JSON) et mémorise la requête. */
    private String startStub(int status, String body) throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/internal/quiz-stats", exchange -> {
            received.add(new Received(
                    exchange.getRequestMethod(),
                    exchange.getRequestURI().getPath(),
                    exchange.getRequestHeaders().getFirst("X-Internal-Token")));
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
            if (bytes.length > 0) {
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            }
            exchange.close();
        });
        server.start();
        return "http://localhost:" + server.getAddress().getPort();
    }

    @Test
    void averageScorePercent_appelleCoreAvecLeJeton_etRenvoieLaMoyenne() throws Exception {
        String url = startStub(200,
                "{\"averageScorePercent\":73,\"gradedAttemptCount\":12,\"studentCount\":4}");

        Integer avg = new CoreQuizStatsClient(url, TOKEN).averageScorePercent(10);

        assertThat(avg).isEqualTo(73);
        assertThat(received).containsExactly(
                new Received("GET", "/internal/quiz-stats/course/10", TOKEN));
    }

    @Test
    void averageScorePercent_null_quandAucunQuizAutoCorrige() throws Exception {
        // core renvoie averageScorePercent=null quand aucune tentative n'est notée.
        String url = startStub(200,
                "{\"averageScorePercent\":null,\"gradedAttemptCount\":0,\"studentCount\":0}");

        assertThat(new CoreQuizStatsClient(url, TOKEN).averageScorePercent(7)).isNull();
        assertThat(received).extracting(Received::path).containsExactly("/internal/quiz-stats/course/7");
    }

    @Test
    void averageScorePercent_null_quandCoreRenvoieUnCorpsVide() throws Exception {
        String url = startStub(200, "");

        assertThat(new CoreQuizStatsClient(url, TOKEN).averageScorePercent(10)).isNull();
    }

    @Test
    void averageScorePercent_null_surErreurServeurDeCore() throws Exception {
        String url = startStub(500, "{\"error\":\"boom\"}");

        assertThat(new CoreQuizStatsClient(url, TOKEN).averageScorePercent(10)).isNull();
        assertThat(received).hasSize(1);
    }

    @Test
    void averageScorePercent_null_siJetonRefuseParCore() throws Exception {
        // Jeton vide (défaut app.internal.token) → core répond 401 : traduit en « non disponible ».
        String url = startStub(401, "");

        assertThat(new CoreQuizStatsClient(url, "").averageScorePercent(10)).isNull();
        assertThat(received.getFirst().token()).isEmpty();
    }

    @Test
    void averageScorePercent_null_siReponseIllisible() throws Exception {
        String url = startStub(200, "pas du json");

        assertThat(new CoreQuizStatsClient(url, TOKEN).averageScorePercent(10)).isNull();
    }

    @Test
    void averageScorePercent_null_siCoreInjoignable() throws Exception {
        int freePort;
        try (ServerSocket socket = new ServerSocket(0)) {
            freePort = socket.getLocalPort();
        }

        assertThat(new CoreQuizStatsClient("http://localhost:" + freePort, TOKEN).averageScorePercent(10))
                .isNull();
    }

    /** Stub qui ne répond qu'après {@code delayMs} (core bloqué). */
    private String startSlowStub(long delayMs) throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/internal", exchange -> {
            exchange.getRequestBody().readAllBytes();
            try {
                Thread.sleep(delayMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            try {
                exchange.sendResponseHeaders(200, -1);
            } catch (IOException ignored) {
                // client déjà parti (délai dépassé)
            }
            exchange.close();
        });
        server.start();
        return "http://localhost:" + server.getAddress().getPort();
    }

    @Test
    void coreBloque_delaiDeLectureDepasse_null() throws Exception {
        // #31 : un core bloqué ne doit pas immobiliser l'analyse ; dépassement = « non disponible ».
        String url = startSlowStub(3_000);

        long start = System.nanoTime();
        assertThat(new CoreQuizStatsClient(url, TOKEN, 2_000, 100).averageScorePercent(10)).isNull();
        assertThat(java.time.Duration.ofNanos(System.nanoTime() - start)).isLessThan(java.time.Duration.ofSeconds(2));
    }

    @Test
    void delaisParDefaut() {
        assertThat(CoreQuizStatsClient.DEFAULT_CONNECT_TIMEOUT_MS).isEqualTo(3_000);
        assertThat(CoreQuizStatsClient.DEFAULT_READ_TIMEOUT_MS).isEqualTo(10_000);
    }
}
