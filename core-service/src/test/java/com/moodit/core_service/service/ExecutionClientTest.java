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
    @DisplayName("502 de cause « sans_verdict » → exception dédiée (comptée), autres 502 → null")
    void evaluate_sansVerdict_exceptionDediee() throws Exception {
        // #116, S4 : le conteneur a tourné sans verdict. Core compte ces échecs par étudiant et
        // par quiz ; une sandbox indisponible, elle, reste un null qui ne compte pas.
        String url = startStub(502, "{\"status\":502,\"detail\":\"Notation sans verdict\","
                + "\"cause\":\"sans_verdict\"}", 0);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> client(url, 2_000, 2_000).evaluate("Python", "code", TWO_HARNESSES))
                .isInstanceOf(com.moodit.core_service.exception.CodeVerificationNoVerdictException.class);
        server.stop(0);

        for (String[] reply : new String[][] {
                {"502", "{\"cause\":\"indisponible\"}"}, {"502", "pas du json"}, {"502", ""},
                {"500", "{\"cause\":\"sans_verdict\"}"}}) {
            String other = startStub(Integer.parseInt(reply[0]), reply[1], 0);
            assertThat(client(other, 2_000, 2_000).evaluate("Python", "code", TWO_HARNESSES))
                    .as("%s %s", reply[0], reply[1]).isNull();
            server.stop(0);
        }
        server = null;
    }

    @Test
    @DisplayName("Corps vide → null")
    void evaluate_corpsVide_null() throws Exception {
        String url = startStub(200, "", 0);

        assertThat(client(url, 2_000, 2_000).evaluate(null, null, TWO_HARNESSES)).isNull();
    }

    @Test
    @DisplayName("Même avec des réglages minuscules, le budget couvre le mur du runner")
    void readTimeout_runnerWallFloor() {
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
    void readTimeout_includesQuestionTimeLimit() {
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
    void readTimeout_cappedByServerBudget() {
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
    void readTimeout_followsOverriddenServerBudget() {
        // Le budget est lu dans la MÊME variable qu'execution-service (EXEC_INTERPRETED_BUDGET_MS) :
        // un plafond client figé devenait trop COURT dès qu'on relevait le budget serveur, et core
        // abandonnait une correction encore en cours — exactement le bug de #216. Ici 30 min.
        ExecutionClient released = new ExecutionClient("http://localhost:1", TOKEN, 2_000,
                10_000, 20_000, 15_000, 30 * 60_000);
        assertThat(released.readTimeoutMs("Python", 100, null))
                .isEqualTo(10_000 + 30 * 60_000 + 145_000);
        // Et un budget serveur ABAISSÉ raccourcit le miroir d'autant (5 min).
        ExecutionClient tight = new ExecutionClient("http://localhost:1", TOKEN, 2_000,
                10_000, 20_000, 15_000, 5 * 60_000);
        assertThat(tight.readTimeoutMs("Python", 100, null))
                .isEqualTo(10_000 + 5 * 60_000 + 145_000);
    }

    /** Port local où RIEN n'écoute : connexion refusée, comme execution-service en redémarrage. */
    private static int closedPort() throws IOException {
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    @Test
    @DisplayName("Service injoignable puis revenu : la connexion est retentée, les verdicts arrivent")
    void evaluate_injoignablePuisRevenu_verdicts() throws Exception {
        // Redémarrage d'execution-service pendant une file de corrections : chaque refus de
        // connexion supprimait une tentative, et la file se vidait en quelques secondes.
        int port = closedPort();
        ExecutionClient client = new ExecutionClient("http://localhost:" + port, TOKEN, 2_000,
                5_000, 5_000, 0, 60_000, 30_000);
        List<Long> pauses = new java.util.ArrayList<>();
        client.sleeper = millis -> {
            pauses.add(millis);
            if (pauses.size() == 2) {      // le service « revient » pendant la deuxième pause
                try {
                    server = HttpServer.create(new InetSocketAddress("localhost", port), 0);
                } catch (IOException e) {
                    throw new java.io.UncheckedIOException(e);
                }
                server.createContext("/internal/exec", exchange -> {
                    byte[] bytes = "[{\"name\":\"cas A\",\"weight\":2,\"passed\":true}]"
                            .getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().add("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, bytes.length);
                    exchange.getResponseBody().write(bytes);
                    exchange.close();
                });
                server.start();
            }
        };

        assertThat(client.evaluate("Python", "x", TWO_HARNESSES.subList(0, 1))).containsExactly(true);
        // Pauses croissantes : 1 s puis 2 s.
        assertThat(pauses).containsExactly(ExecutionClient.RETRY_FIRST_DELAY_MS,
                2 * ExecutionClient.RETRY_FIRST_DELAY_MS);
    }

    @Test
    @DisplayName("Service injoignable au-delà du budget de reprise → null, pauses bornées")
    void evaluate_injoignableAuDelaDuBudget_null() throws Exception {
        ExecutionClient client = new ExecutionClient("http://localhost:" + closedPort(), TOKEN,
                2_000, 5_000, 5_000, 0, 60_000, 300);
        List<Long> pauses = new java.util.ArrayList<>();
        client.sleeper = millis -> {
            pauses.add(millis);
            Thread.sleep(millis);
        };

        assertThat(client.evaluate("Python", "x", TWO_HARNESSES)).isNull();
        assertThat(pauses).isNotEmpty().allMatch(p -> p > 0 && p <= 300);
        assertThat(pauses.stream().mapToLong(Long::longValue).sum()).isLessThanOrEqualTo(300);
    }

    @Test
    @DisplayName("Interruption pendant l'attente (arrêt de core) → exception dédiée, drapeau rétabli")
    void evaluate_interrompuPendantLAttente_exceptionDediee() throws Exception {
        ExecutionClient client = new ExecutionClient("http://localhost:" + closedPort(), TOKEN,
                2_000, 5_000, 5_000, 0, 60_000, 30_000);
        client.sleeper = millis -> {
            throw new InterruptedException();
        };
        try {
            // Pas `null` (sandbox indisponible → tentative supprimée) : la tentative doit rester
            // « pending » pour la reprise au démarrage.
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> client.evaluate("Python", "x", TWO_HARNESSES))
                    .isInstanceOf(
                            com.moodit.core_service.exception.GradingInterruptedException.class);
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    @DisplayName("Erreur HTTP ou délai de lecture : jamais retenté (la correction a pu tourner)")
    void evaluate_erreurApresConnexion_pasDeNouvelEssai() throws Exception {
        List<Long> pauses = new java.util.ArrayList<>();
        // 502 d'execution-service : une seule requête.
        ExecutionClient failing = new ExecutionClient(startStub(502, "{}", 0), TOKEN, 2_000,
                5_000, 5_000, 0, 60_000, 30_000);
        failing.sleeper = pauses::add;
        assertThat(failing.evaluate("Python", "x", TWO_HARNESSES)).isNull();
        server.stop(0);
        // Délai de lecture dépassé : la requête est partie, on ne la renvoie pas.
        ExecutionClient slow = new ExecutionClient(startStub(200, "[]", 1_500), TOKEN, 2_000,
                0, 100, 0, 200, 30_000) {
            @Override
            long readTimeoutMs(String language, int units, Integer timeoutMs) {
                return 300;
            }
        };
        slow.sleeper = pauses::add;
        assertThat(slow.evaluate("Python", "x", TWO_HARNESSES)).isNull();
        assertThat(pauses).isEmpty();

        assertThat(ExecutionClient.unreachable(new org.springframework.web.client.ResourceAccessException(
                "x", new java.net.ConnectException("Connection refused")))).isTrue();
        assertThat(ExecutionClient.unreachable(new org.springframework.web.client.ResourceAccessException(
                "x", new java.net.UnknownHostException("execution-service")))).isTrue();
        assertThat(ExecutionClient.unreachable(new org.springframework.web.client.ResourceAccessException(
                "x", new java.net.NoRouteToHostException("No route to host")))).isTrue();
        assertThat(ExecutionClient.unreachable(new org.springframework.web.client.ResourceAccessException(
                "x", new java.net.SocketTimeoutException("Connect timed out")))).isTrue();
        assertThat(ExecutionClient.unreachable(new org.springframework.web.client.ResourceAccessException(
                "x", new java.net.SocketTimeoutException("Read timed out")))).isFalse();
        assertThat(ExecutionClient.unreachable(new org.springframework.web.client.ResourceAccessException(
                "x", new java.net.SocketTimeoutException()))).isFalse();
        assertThat(ExecutionClient.unreachable(new org.springframework.web.client.ResourceAccessException(
                "x", new IOException("rompu")))).isFalse();
        assertThat(ExecutionClient.unreachable(
                new org.springframework.web.client.RestClientException("x"))).isFalse();
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
    void evaluate_sendsTimeoutInBody() throws IOException {
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
    @DisplayName("Harnais sans nom ou sans code : « cas N » et chaîne vide, au lieu d'un 400 ou d'une exception à chaque correction")
    void evaluate_namesUnnamedHarnesses() throws IOException {
        String url = startStub(200,
                "[{\"name\":\"cas 1\",\"weight\":1,\"passed\":true,\"detail\":null},"
                        + "{\"name\":\"cas 2\",\"weight\":1,\"passed\":true,\"detail\":null},"
                        + "{\"name\":\"ok\",\"weight\":1,\"passed\":true,\"detail\":null}]", 0);
        ExecutionClient client = client(url, 10_000, 20_000, 15_000);

        assertThat(client.evaluate("Python", "code", List.of(
                new ExecutionClient.Harness(null, null, 1),
                new ExecutionClient.Harness("  ", "assert B", 1),
                new ExecutionClient.Harness("ok", "assert C", 1)))).containsExactly(true, true, true);
        assertThat(receivedBody.get())
                .contains("\"name\":\"cas 1\"").contains("\"harnessCode\":\"\"")
                .contains("\"name\":\"cas 2\"").contains("\"name\":\"ok\"");
    }

    @Test
    @DisplayName("Le code de départ de la question part dans le corps HTTP (startCode), absent s'il n'y en a pas")
    void evaluate_sendsStartCodeInBody() throws IOException {
        String url = startStub(200,
                "[{\"name\":\"cas A\",\"weight\":2,\"passed\":true,\"detail\":null},"
                        + "{\"name\":\"cas B\",\"weight\":1,\"passed\":true,\"detail\":null}]", 0);
        ExecutionClient client = client(url, 10_000, 20_000, 15_000);

        client.evaluate("Python", "code", TWO_HARNESSES, null, "def sum(l):\n    pass");
        assertThat(receivedBody.get()).contains("\"startCode\":\"def sum(l):\\n    pass\"");

        client.evaluate("Python", "code", TWO_HARNESSES, null, null);
        assertThat(receivedBody.get()).doesNotContain("startCode");
    }

    @Test
    @DisplayName("Un harnais SQL compte pour deux appels (exécution en deux phases), les autres pour un")
    void workUnits_sqlInTwoPhases() {
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
