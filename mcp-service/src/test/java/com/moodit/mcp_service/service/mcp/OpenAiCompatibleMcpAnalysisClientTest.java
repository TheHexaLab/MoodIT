package com.moodit.mcp_service.service.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.moodit.mcp_service.dto.McpAnalysis;
import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

/**
 * Client LLM (API compatible OpenAI). On ne teste PAS le modèle : on teste le PARSING et les
 * garanties du backend — score borné, `sources` RÉINJECTÉES côté serveur (jamais celles du
 * modèle), tolérance au texte autour du JSON, et échecs → {@link McpAnalysisException}.
 * Un mini serveur HTTP (JDK) tient lieu d'endpoint /chat/completions, sans dépendance externe.
 */
class OpenAiCompatibleMcpAnalysisClientTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    /** Démarre un stub renvoyant (status, body) sur /chat/completions et retourne sa base-url. */
    private String startStub(int status, String body) throws Exception {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/chat/completions", exchange -> {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();
        return "http://localhost:" + server.getAddress().getPort();
    }

    /** Enveloppe OpenAI dont le champ message.content porte la chaîne JSON du modèle. */
    private String envelope(String content) {
        return mapper.writeValueAsString(
                Map.of("choices", List.of(Map.of("message", Map.of("content", content)))));
    }

    private CourseAnalysisContext ctx() {
        return new CourseAnalysisContext(
                1, "Titre", "C1", 7, 12, 3, List.of("un message"), 5, 3, null, null);
    }

    private OpenAiCompatibleMcpAnalysisClient client(String baseUrl, String apiKey) {
        return new OpenAiCompatibleMcpAnalysisClient(mapper, baseUrl, apiKey, "test-model", 5000);
    }

    private static final String ANALYSIS_JSON =
            "{\"score\":150,\"summary\":\"ok\",\"dimensions\":{\"content\":95,\"engagement\":-10,"
                    + "\"success\":70,\"sentiment\":80},\"strengths\":[\"f1\",\"f2\"],"
                    + "\"improvements\":[\"i1\"],\"recommendations\":[\"r1\",\"r2\"],"
                    + "\"sources\":{\"quizCount\":999,\"forumMessageCount\":999,\"studentCount\":999}}";

    @Test
    void parses_clampsScoreAndDimensions_andReinjectsRealSources() throws Exception {
        String url = startStub(200, envelope(ANALYSIS_JSON));

        McpAnalysis result = client(url, "key").analyze(ctx());

        assertThat(result.score()).isEqualTo(100);            // 150 borné
        assertThat(result.dimensions().engagement()).isZero(); // -10 borné
        assertThat(result.dimensions().content()).isEqualTo(95);
        assertThat(result.strengths()).containsExactly("f1", "f2");
        assertThat(result.improvements()).containsExactly("i1");
        // Sources = ctx (7/12/3), PAS les 999 renvoyés par le modèle.
        assertThat(result.sources().quizCount()).isEqualTo(7);
        assertThat(result.sources().forumMessageCount()).isEqualTo(12);
        assertThat(result.sources().studentCount()).isEqualTo(3);
    }

    @Test
    void extractsJsonObject_evenWhenModelWrapsItInText() throws Exception {
        String url = startStub(200, envelope("Voici l'analyse : " + ANALYSIS_JSON + " voilà."));

        assertThat(client(url, "key").analyze(ctx()).score()).isEqualTo(100);
    }

    @Test
    void throws_whenResponseHasNoContent() throws Exception {
        String url = startStub(200,
                mapper.writeValueAsString(Map.of("choices", List.of(Map.of("message", Map.of())))));

        assertThatThrownBy(() -> client(url, "key").analyze(ctx()))
                .isInstanceOf(McpAnalysisException.class);
    }

    @Test
    void throws_onServerError() throws Exception {
        String url = startStub(500, "boom");

        assertThatThrownBy(() -> client(url, "key").analyze(ctx()))
                .isInstanceOf(McpAnalysisException.class);
    }

    @Test
    void throws_immediately_whenApiKeyBlank() {
        // Aucun appel réseau attendu : garde en amont.
        assertThatThrownBy(() -> client("http://unused", "  ").analyze(ctx()))
                .isInstanceOf(McpAnalysisException.class);
    }
}
