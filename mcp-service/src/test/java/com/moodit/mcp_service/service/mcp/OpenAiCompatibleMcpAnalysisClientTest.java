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

    // ── Compléments (#90) : requête envoyée et décisions N/D côté backend ──

    /** Requête capturée par le stub : en-tête Authorization et corps JSON. */
    private final java.util.concurrent.atomic.AtomicReference<String> capturedAuth =
            new java.util.concurrent.atomic.AtomicReference<>();
    private final java.util.concurrent.atomic.AtomicReference<String> capturedBody =
            new java.util.concurrent.atomic.AtomicReference<>();

    /** Comme {@link #startStub} mais mémorise la requête reçue. */
    private String startCapturingStub(String body) throws Exception {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/chat/completions", exchange -> {
            capturedAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            capturedBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();
        return "http://localhost:" + server.getAddress().getPort();
    }

    @Test
    void requete_porteLaCleBearer_leModele_etLeFormatJson() throws Exception {
        String url = startCapturingStub(envelope(ANALYSIS_JSON));

        client(url, "cle-secrete").analyze(ctx());

        assertThat(capturedAuth.get()).isEqualTo("Bearer cle-secrete");
        tools.jackson.databind.JsonNode sent = mapper.readTree(capturedBody.get());
        assertThat(sent.path("model").asText()).isEqualTo("test-model");
        assertThat(sent.path("stream").asBoolean(true)).isFalse();
        assertThat(sent.path("response_format").path("type").asText()).isEqualTo("json_object");
        assertThat(sent.path("messages").get(0).path("role").asText()).isEqualTo("system");
        assertThat(sent.path("messages").get(1).path("role").asText()).isEqualTo("user");
    }

    @Test
    void prompt_contientLesVraisChiffres_etAnonymiseLesMessages() throws Exception {
        String url = startCapturingStub(envelope(ANALYSIS_JSON));
        CourseAnalysisContext c = new CourseAnalysisContext(
                1, null, "IFT101", 4, 2, 9,
                List.of("écrivez-moi à jean.doe@usherbrooke.ca\nmerci"), 6, 3, 80, 72);

        client(url, "key").analyze(c);

        String prompt = mapper.readTree(capturedBody.get()).path("messages").get(1).path("content").asText();
        // Titre absent → libellé générique « Cours » ; vrais compteurs injectés.
        assertThat(prompt).contains("Cours : Cours (IFT101)");
        assertThat(prompt).contains("- Quiz : 4", "- Messages de forum : 2", "- Étudiants inscrits : 9");
        assertThat(prompt).contains("6 tentative(s) par 3 étudiant(s)");
        assertThat(prompt).contains("72% de réussite moyenne", "80% des cas de test réussis");
        // PII retiré AVANT l'envoi au LLM externe, retour à la ligne aplati.
        assertThat(prompt).doesNotContain("jean.doe@usherbrooke.ca");
        assertThat(prompt).contains("  - écrivez-moi à [courriel] merci");
    }

    @Test
    void prompt_signaleLesMetriquesNonDisponibles_etLAbsenceDeMessages() throws Exception {
        String url = startCapturingStub(envelope(ANALYSIS_JSON));
        CourseAnalysisContext c = new CourseAnalysisContext(
                1, "Titre", "C1", 0, 0, 0, List.of(), 0, 0, null, null);

        client(url, "key").analyze(c);

        String prompt = mapper.readTree(capturedBody.get()).path("messages").get(1).path("content").asText();
        assertThat(prompt).contains("Score moyen aux quiz (questions auto-corrigées) : non disponible");
        assertThat(prompt).contains("Réussite aux questions de code : non disponible");
        assertThat(prompt).contains("(aucun message)");
    }

    @Test
    void dimensions_ND_decideesParLeBackend_etContentNulSansQuiz() throws Exception {
        // Le modèle renvoie des valeurs, mais sans quiz / sans réussite / sans message le backend
        // impose content=0, success=null, sentiment=null (jamais un 50 trompeur).
        String url = startStub(200, envelope(ANALYSIS_JSON));
        CourseAnalysisContext c = new CourseAnalysisContext(
                1, "Titre", "C1", 0, 0, 3, List.of(), 0, 0, null, null);

        McpAnalysis a = client(url, "key").analyze(c);

        assertThat(a.dimensions().content()).isZero();
        assertThat(a.dimensions().success()).isNull();
        assertThat(a.dimensions().sentiment()).isNull();
        assertThat(a.dimensions().engagement()).isZero(); // -10 borné à 0
    }

    @Test
    void dimensions_successConnueParLeSeulTauxDeCode() throws Exception {
        String url = startStub(200, envelope(ANALYSIS_JSON));
        CourseAnalysisContext c = new CourseAnalysisContext(
                1, "Titre", "C1", 2, 1, 3, List.of("x"), 1, 1, 60, null);

        McpAnalysis a = client(url, "key").analyze(c);

        assertThat(a.dimensions().success()).isEqualTo(70);
        assertThat(a.dimensions().sentiment()).isEqualTo(80);
    }

    @Test
    void listesNonTableau_ouEntreesVides_sontIgnorees() throws Exception {
        String json = "{\"score\":40,\"summary\":\"s\",\"strengths\":\"pas une liste\","
                + "\"improvements\":[\"i1\",\"\",\"  \"],\"recommendations\":null}";
        String url = startStub(200, envelope(json));

        McpAnalysis a = client(url, "key").analyze(ctx());

        assertThat(a.score()).isEqualTo(40);
        assertThat(a.strengths()).isEmpty();
        assertThat(a.improvements()).containsExactly("i1");
        assertThat(a.recommendations()).isEmpty();
    }

    @Test
    void contenuNonJson_leveMcpAnalysisException_pourDeclencherLeRepli() throws Exception {
        // Le runner bascule sur le repli déterministe UNIQUEMENT sur McpAnalysisException :
        // un texte non JSON du modèle doit donc être traduit en cette exception.
        String url = startStub(200, envelope("désolé, je ne peux pas répondre"));

        assertThatThrownBy(() -> client(url, "key").analyze(ctx()))
                .isInstanceOf(McpAnalysisException.class)
                .hasMessageStartingWith("Réponse LLM illisible");
    }

    @Test
    void enveloppeNonJson_leveMcpAnalysisException() throws Exception {
        String url = startStub(200, "<html>proxy</html>");

        assertThatThrownBy(() -> client(url, "key").analyze(ctx()))
                .isInstanceOf(McpAnalysisException.class);
    }

    @Test
    void llmInjoignable_leveMcpAnalysisException() throws Exception {
        int freePort;
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0)) {
            freePort = socket.getLocalPort();
        }

        assertThatThrownBy(() -> client("http://localhost:" + freePort, "key").analyze(ctx()))
                .isInstanceOf(McpAnalysisException.class)
                .hasMessageStartingWith("Appel au LLM échoué");
    }

    @Test
    void cleNulle_leveMcpAnalysisException_sansAppel() {
        assertThatThrownBy(() -> client("http://unused", null).analyze(ctx()))
                .isInstanceOf(McpAnalysisException.class)
                .hasMessageContaining("Clé API LLM absente");
    }
}
