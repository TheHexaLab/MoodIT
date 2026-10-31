package com.moodit.execution_service.piston;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClientException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Tests unitaires du client Piston, SANS vrai Piston : un faux serveur HTTP (JDK, boucle locale,
 * port éphémère) joue le rôle de l'API v2. Le {@code RestClient} est construit à l'intérieur de
 * {@link PistonClient} (non injectable, donc pas de {@code MockRestServiceServer} sans réflexion) :
 * le serveur local permet de vérifier la requête RÉELLEMENT émise (méthode, URL, en-tête, corps
 * JSON), l'interprétation de la réponse, la traduction des erreurs et le délai HTTP configuré.
 */
class PistonClientTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private HttpServer server;
    private String baseUrl;

    /** Dernière requête reçue par le faux Piston. */
    private final AtomicReference<String> lastMethod = new AtomicReference<>();
    private final AtomicReference<String> lastPath = new AtomicReference<>();
    private final AtomicReference<String> lastContentType = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();

    /** Réponse programmée du faux Piston. */
    private volatile int status = 200;
    private volatile String responseBody = "";
    private volatile long delayMs = 0;

    @BeforeEach
    void startFakePiston() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", this::handle);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopFakePiston() {
        server.stop(0);
    }

    private void handle(HttpExchange exchange) throws IOException {
        lastMethod.set(exchange.getRequestMethod());
        lastPath.set(exchange.getRequestURI().getPath());
        lastContentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
        lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        if (delayMs > 0) {
            try {
                Thread.sleep(delayMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        byte[] bytes = responseBody.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        try {
            if (bytes.length == 0) {
                exchange.sendResponseHeaders(status, -1); // aucun corps
            } else {
                exchange.sendResponseHeaders(status, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            }
        } catch (IOException ignored) {
            // Client parti (test de délai) : sans importance.
        } finally {
            exchange.close();
        }
    }

    private PistonClient client(int httpTimeoutMs) {
        return new PistonClient(baseUrl, 3000, 10000, httpTimeoutMs);
    }

    private void respond(int code, String body) {
        this.status = code;
        this.responseBody = body;
    }

    private static List<PistonClient.File> oneFile() {
        return List.of(new PistonClient.File("a.py", ""));
    }

    private static final String OK_RESPONSE = """
            {"language":"python","version":"3.12.0",
             "compile":{"stdout":"","stderr":"avertissement","code":0,"signal":null,"output":""},
             "run":{"stdout":"bonjour\\n","stderr":"MOODIT_OK_x","code":0,"signal":null,"output":"bonjour"}}
            """;

    @Test
    void envoie_un_post_json_sur_api_v2_execute_avec_fichiers_et_limites() throws Exception {
        respond(200, OK_RESPONSE);
        PistonClient c = new PistonClient(baseUrl, 2500, 9000, 20000);

        c.execute("python", "3.12.0", List.of(
                new PistonClient.File("grader.py", "print(1)"),
                new PistonClient.File("student_server.py", "x = 'é'")));

        assertThat(lastMethod.get()).isEqualTo("POST");
        assertThat(lastPath.get()).isEqualTo("/api/v2/execute");
        assertThat(lastContentType.get()).startsWith("application/json");
        JsonNode body = JSON.readTree(lastBody.get());
        assertThat(body.get("language").asString()).isEqualTo("python");
        assertThat(body.get("version").asString()).isEqualTo("3.12.0");
        // Les limites configurées sont transmises telles quelles à Piston.
        assertThat(body.get("run_timeout").asInt()).isEqualTo(2500);
        assertThat(body.get("compile_timeout").asInt()).isEqualTo(9000);
        // Les fichiers sont envoyés dans l'ordre (le 1er = point d'entrée), contenu intact (UTF-8).
        assertThat(body.get("files")).hasSize(2);
        assertThat(body.get("files").get(0).get("name").asString()).isEqualTo("grader.py");
        assertThat(body.get("files").get(0).get("content").asString()).isEqualTo("print(1)");
        assertThat(body.get("files").get(1).get("name").asString()).isEqualTo("student_server.py");
        assertThat(body.get("files").get(1).get("content").asString()).isEqualTo("x = 'é'");
        // Limites mémoire par défaut (#24) : sans elles, Piston n'en applique aucune.
        assertThat(body.get("run_memory_limit").asLong()).isEqualTo(256_000_000L);
        assertThat(body.get("compile_memory_limit").asLong()).isEqualTo(512_000_000L);
        assertThat(body.size()).isEqualTo(7); // aucun champ superflu
    }

    @Test
    void envoie_les_limites_memoire_configurees() throws Exception {
        respond(200, OK_RESPONSE);
        PistonClient c = new PistonClient(baseUrl, 3000, 10000, 20000, 128_000_000L, 300_000_000L);

        c.execute("python", "*", oneFile());

        JsonNode body = JSON.readTree(lastBody.get());
        assertThat(body.get("run_memory_limit").asLong()).isEqualTo(128_000_000L);
        assertThat(body.get("compile_memory_limit").asLong()).isEqualTo(300_000_000L);
    }

    @Test
    void limite_memoire_nulle_ou_negative_n_est_pas_envoyee() throws Exception {
        // ≤ 0 : on laisse Piston appliquer sa configuration (0 serait lu comme « 0 octet »).
        respond(200, OK_RESPONSE);
        new PistonClient(baseUrl, 3000, 10000, 20000, 0L, -1L).execute("python", "*", oneFile());

        JsonNode body = JSON.readTree(lastBody.get());
        assertThat(body.has("run_memory_limit")).isFalse();
        assertThat(body.has("compile_memory_limit")).isFalse();
        assertThat(body.size()).isEqualTo(5);

        // Une seule des deux à 0 : l'autre est quand même envoyée.
        new PistonClient(baseUrl, 3000, 10000, 20000, 1L, 0L).execute("python", "*", oneFile());
        body = JSON.readTree(lastBody.get());
        assertThat(body.get("run_memory_limit").asLong()).isEqualTo(1L);
        assertThat(body.has("compile_memory_limit")).isFalse();
    }

    @Test
    void interprete_les_etapes_compile_et_run_de_la_reponse() {
        respond(200, OK_RESPONSE);

        PistonClient.Result r = client(20000).execute("python", "*", oneFile());

        // Les champs inconnus (language, version, output) sont ignorés sans erreur.
        assertThat(r.compile()).isEqualTo(new PistonClient.Stage("", "avertissement", 0, null, null));
        assertThat(r.run()).isEqualTo(new PistonClient.Stage("bonjour\n", "MOODIT_OK_x", 0, null, null));
        assertThat(r.message()).isNull();
    }

    @Test
    void interprete_un_signal_et_un_code_absent() {
        // Dépassement de temps côté Piston : signal SIGKILL, code null, pas d'étape compile.
        respond(200, """
                {"run":{"stdout":"","stderr":"","code":null,"signal":"SIGKILL","message":"killed"}}
                """);

        PistonClient.Result r = client(20000).execute("python", "*", oneFile());

        assertThat(r.compile()).isNull();
        assertThat(r.run().code()).isNull();
        assertThat(r.run().signal()).isEqualTo("SIGKILL");
        assertThat(r.run().message()).isEqualTo("killed");
    }

    @Test
    void version_nulle_ou_vide_devient_joker() throws Exception {
        respond(200, OK_RESPONSE);
        PistonClient c = client(20000);

        c.execute("python", null, oneFile());
        assertThat(JSON.readTree(lastBody.get()).get("version").asString()).isEqualTo("*");

        c.execute("python", "   ", oneFile());
        assertThat(JSON.readTree(lastBody.get()).get("version").asString()).isEqualTo("*");
    }

    @Test
    void message_sans_etape_run_est_traduit_en_piston_exception() {
        // Erreur de requête Piston (ex. runtime inconnu) : HTTP 200, pas de « run », un message.
        respond(200, "{\"message\":\"rust-9.9.9 runtime is unknown\"}");

        assertThatThrownBy(() -> client(20000).execute("rust", "9.9.9", oneFile()))
                .isInstanceOf(PistonException.class)
                .hasMessage("Piston: rust-9.9.9 runtime is unknown");
    }

    @Test
    void message_avec_etape_run_est_renvoye_sans_exception() {
        // Un message accompagné d'une étape run n'est PAS une erreur de requête : résultat renvoyé.
        respond(200, "{\"run\":{\"stdout\":\"ok\",\"stderr\":\"\",\"code\":0},\"message\":\"info\"}");

        PistonClient.Result r = client(20000).execute("python", "*", oneFile());

        assertThat(r.run().stdout()).isEqualTo("ok");
        assertThat(r.message()).isEqualTo("info");
    }

    @Test
    void reponse_sans_run_ni_message_est_renvoyee_telle_quelle() {
        // Ni run ni message : pas d'erreur détectable ici, ExecutionService gère l'absence de run.
        respond(200, "{\"compile\":{\"stdout\":\"\",\"stderr\":\"erreur\",\"code\":1}}");

        PistonClient.Result r = client(20000).execute("c", "*", oneFile());

        assertThat(r.run()).isNull();
        assertThat(r.compile().code()).isEqualTo(1);
        assertThat(r.compile().stderr()).isEqualTo("erreur");
    }

    @Test
    void corps_vide_est_traduit_en_piston_exception() {
        respond(200, "");

        assertThatThrownBy(() -> client(20000).execute("python", "*", oneFile()))
                .isInstanceOf(PistonException.class)
                .hasMessage("Réponse Piston vide");
    }

    @Test
    void erreur_http_400_est_traduite_en_piston_exception_avec_cause() {
        respond(400, "{\"message\":\"files is required\"}");

        assertThatThrownBy(() -> client(20000).execute("python", "*", oneFile()))
                .isInstanceOf(PistonException.class)
                .hasMessageStartingWith("Appel Piston échoué : ")
                .hasMessageContaining("400")
                .hasCauseInstanceOf(HttpClientErrorException.class);
    }

    @Test
    void erreur_http_500_est_traduite_en_piston_exception_avec_cause() {
        respond(500, "{\"message\":\"boom\"}");

        assertThatThrownBy(() -> client(20000).execute("python", "*", oneFile()))
                .isInstanceOf(PistonException.class)
                .hasMessageStartingWith("Appel Piston échoué : ")
                .hasMessageContaining("500")
                .hasCauseInstanceOf(HttpServerErrorException.class);
    }

    @Test
    void json_illisible_est_traduit_en_piston_exception() {
        respond(200, "{pas du json");

        assertThatThrownBy(() -> client(20000).execute("python", "*", oneFile()))
                .isInstanceOf(PistonException.class)
                .hasMessageStartingWith("Appel Piston échoué : ")
                .hasCauseInstanceOf(RestClientException.class);
    }

    @Test
    void delai_http_depasse_est_traduit_en_piston_exception() {
        // Le faux Piston répond après 2 s ; le client est configuré à 300 ms de délai de lecture.
        respond(200, OK_RESPONSE);
        delayMs = 2000;
        long start = System.nanoTime();

        // Selon le moment où le délai tombe (lecture de l'en-tête ou du corps), Spring lève une
        // ResourceAccessException ou une RestClientException d'extraction : les deux sont traduites.
        assertThatThrownBy(() -> client(300).execute("python", "*", oneFile()))
                .isInstanceOf(PistonException.class)
                .hasMessageStartingWith("Appel Piston échoué : ")
                .hasCauseInstanceOf(RestClientException.class);
        // On a bien abandonné au délai configuré, sans attendre la réponse.
        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(1800);
    }

    @Test
    void piston_injoignable_est_traduit_en_piston_exception() throws Exception {
        // Port libre réservé puis relâché : rien n'écoute dessus → connexion refusée.
        int freePort;
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            freePort = s.getLocalPort();
        }
        PistonClient c = new PistonClient("http://127.0.0.1:" + freePort, 3000, 10000, 2000);

        assertThatThrownBy(() -> c.execute("python", "*", oneFile()))
                .isInstanceOf(PistonException.class)
                .hasMessageStartingWith("Appel Piston échoué : ")
                .hasCauseInstanceOf(ResourceAccessException.class);
    }
}
