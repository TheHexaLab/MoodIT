package com.moodit.mcp_service.service.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.moodit.mcp_service.dto.McpResponseSummaryDto;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Pont WS vers core-service : on vérifie le CONTRAT HTTP de l'appel interne — chemin, en-tête
 * {@code X-Internal-Token}, Content-Type JSON et charge utile — ainsi que la tolérance aux pannes
 * (un push raté ne doit JAMAIS faire échouer le job : le front resynchronise à la reconnexion).
 * Le {@code RestClient} est construit en interne par la classe : on tient donc lieu de core-service
 * avec un mini serveur HTTP (JDK) qui enregistre les requêtes reçues, comme pour le client LLM.
 */
class McpRealtimeGatewayTest {

    private static final String TOKEN = "jeton-interne-de-test";

    /** Requête reçue par le stub (ce que core-service verrait). */
    private record Received(String method, String path, String token, String contentType, JsonNode body) {}

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<Received> received = new CopyOnWriteArrayList<>();
    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    /** Démarre un stub qui répond {@code status} à tout POST sous /internal et mémorise la requête. */
    private String startStub(int status) throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/internal", exchange -> {
            String raw = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            received.add(new Received(
                    exchange.getRequestMethod(),
                    exchange.getRequestURI().getPath(),
                    exchange.getRequestHeaders().getFirst("X-Internal-Token"),
                    exchange.getRequestHeaders().getFirst("Content-Type"),
                    raw.isEmpty() ? null : mapper.readTree(raw)));
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
        });
        server.start();
        return "http://localhost:" + server.getAddress().getPort();
    }

    @Test
    void analysisCreated_posteLeResumeAvecLeJetonInterne() throws Exception {
        McpRealtimeGateway gateway = new McpRealtimeGateway(startStub(200), TOKEN);

        gateway.analysisCreated(10L, new McpResponseSummaryDto(42L, "2026-07-02T16:21:38Z", 3, 2));

        assertThat(received).hasSize(1);
        Received r = received.getFirst();
        assertThat(r.method()).isEqualTo("POST");
        assertThat(r.path()).isEqualTo("/internal/realtime/mcp/analysis-created");
        assertThat(r.token()).isEqualTo(TOKEN);
        assertThat(r.contentType()).startsWith("application/json");
        // Charge utile = miroir de ce que core relaie en WS (mcp:analysis-created, room mcp:10).
        assertThat(r.body().path("courseId").asLong()).isEqualTo(10L);
        assertThat(r.body().path("id").asLong()).isEqualTo(42L);
        assertThat(r.body().path("createdAt").asText()).isEqualTo("2026-07-02T16:21:38Z");
        assertThat(r.body().path("strengthsCount").asInt()).isEqualTo(3);
        assertThat(r.body().path("improvementsCount").asInt()).isEqualTo(2);
        assertThat(r.body().size()).as("aucun champ inattendu").isEqualTo(5);
    }

    @Test
    void analysisFailed_posteLeMotifPourLeCoursEtLUtilisateur() throws Exception {
        McpRealtimeGateway gateway = new McpRealtimeGateway(startStub(200), TOKEN);

        gateway.analysisFailed(10L, 5L, "Analyse indisponible pour le moment.");

        assertThat(received).hasSize(1);
        Received r = received.getFirst();
        assertThat(r.method()).isEqualTo("POST");
        assertThat(r.path()).isEqualTo("/internal/realtime/mcp/analysis-failed");
        assertThat(r.token()).isEqualTo(TOKEN);
        assertThat(r.contentType()).startsWith("application/json");
        assertThat(r.body().path("courseId").asLong()).isEqualTo(10L);
        assertThat(r.body().path("userId").asLong()).isEqualTo(5L);
        assertThat(r.body().path("reason").asText()).isEqualTo("Analyse indisponible pour le moment.");
        assertThat(r.body().size()).isEqualTo(3);
    }

    @Test
    void analysisProgress_posteLEtapeCourante() throws Exception {
        McpRealtimeGateway gateway = new McpRealtimeGateway(startStub(200), TOKEN);

        gateway.analysisProgress(10L, 5L, "analyzing");

        assertThat(received).hasSize(1);
        Received r = received.getFirst();
        assertThat(r.method()).isEqualTo("POST");
        assertThat(r.path()).isEqualTo("/internal/realtime/mcp/analysis-progress");
        assertThat(r.token()).isEqualTo(TOKEN);
        assertThat(r.body().path("courseId").asLong()).isEqualTo(10L);
        assertThat(r.body().path("userId").asLong()).isEqualTo(5L);
        assertThat(r.body().path("step").asText()).isEqualTo("analyzing");
        assertThat(r.body().size()).isEqualTo(3);
    }

    @Test
    void chaqueNotification_viseSonProprePointDeTerminaison() throws Exception {
        // Les pushs successifs d'un même job partent vers des chemins distincts, dans l'ordre.
        McpRealtimeGateway gateway = new McpRealtimeGateway(startStub(200), TOKEN);

        gateway.analysisProgress(10L, 5L, "collecting");
        gateway.analysisProgress(10L, 5L, "fallback");
        gateway.analysisCreated(10L, new McpResponseSummaryDto(1L, null, 2, 2));

        assertThat(received).extracting(Received::path).containsExactly(
                "/internal/realtime/mcp/analysis-progress",
                "/internal/realtime/mcp/analysis-progress",
                "/internal/realtime/mcp/analysis-created");
        assertThat(received).extracting(r -> r.body().path("step").asText(null))
                .containsExactly("collecting", "fallback", null);
        // createdAt null est transmis tel quel (null JSON), ni omis ni transformé.
        assertThat(received.get(2).body().has("createdAt")).isTrue();
        assertThat(received.get(2).body().get("createdAt").isNull()).isTrue();
    }

    @Test
    void jetonInterneVide_estEnvoyeVide_etNonOmis() throws Exception {
        // Valeur par défaut de app.internal.token = "" : l'en-tête part vide, core refusera (401),
        // mais le pont ne doit pas planter sur un jeton absent.
        McpRealtimeGateway gateway = new McpRealtimeGateway(startStub(401), "");

        assertThatCode(() -> gateway.analysisProgress(1L, 1L, "collecting")).doesNotThrowAnyException();
        assertThat(received).hasSize(1);
        assertThat(received.getFirst().token()).isEmpty();
    }

    @Test
    void erreurHttpDeCore_estAvalee_sansPropagerAuJob() throws Exception {
        // 500 côté core : le résultat est déjà en base, le push WS raté est juste loggué.
        McpRealtimeGateway gateway = new McpRealtimeGateway(startStub(500), TOKEN);

        assertThatCode(() -> gateway.analysisCreated(10L, new McpResponseSummaryDto(1L, "x", 0, 0)))
                .doesNotThrowAnyException();
        assertThatCode(() -> gateway.analysisFailed(10L, 5L, "motif")).doesNotThrowAnyException();
        assertThatCode(() -> gateway.analysisProgress(10L, 5L, "analyzing")).doesNotThrowAnyException();
        // Les trois appels ont bien été tentés (pas de court-circuit après le premier échec).
        assertThat(received).hasSize(3);
    }

    @Test
    void coreInjoignable_estAvale_sansPropagerAuJob() throws Exception {
        // Port libre réservé puis refermé : connexion refusée (core-service éteint).
        int freePort;
        try (ServerSocket socket = new ServerSocket(0)) {
            freePort = socket.getLocalPort();
        }
        McpRealtimeGateway gateway = new McpRealtimeGateway("http://localhost:" + freePort, TOKEN);

        assertThatCode(() -> gateway.analysisCreated(10L, new McpResponseSummaryDto(1L, "x", 1, 1)))
                .doesNotThrowAnyException();
        assertThatCode(() -> gateway.analysisFailed(10L, 5L, "motif")).doesNotThrowAnyException();
        assertThatCode(() -> gateway.analysisProgress(10L, 5L, "collecting")).doesNotThrowAnyException();
    }
}
