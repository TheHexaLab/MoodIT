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
 * l'ordre des harnais ; {@code null} sur une panne ordinaire, exception dédiée sur un 502
 * « sans_verdict » (comptée par étudiant et par quiz) ; nouveaux essais limités dans le temps tant
 * que le service est injoignable ({@code null} une fois la fenêtre écoulée), et, si core s'arrête
 * pendant une pause, {@code GradingInterruptedException} ; délai de lecture par unité pour les
 * interprétés (attente de file comprise, plafonné par le budget du serveur) et, pour les compilés,
 * une seule attente de file plus le miroir du mur, plafonné par celui-ci (#31, #216, #116). Mini
 * serveur HTTP (JDK) en guise d'execution-service.
 */
class ExecutionClientTest {

    private static final String TOKEN = "jeton-interne-de-test";

    /**
     * Cycle de vie d'un conteneur HORS mur, écrit terme à terme d'après DockerSandbox.run
     * (execution-service) : 7 appels au démon (info, create, copie, start, exitCodeIfStopped,
     * oomKilled, suppression), chacun borné par CONNECTION_TIMEOUT (5 s) + RESPONSE_TIMEOUT
     * (60 s), plus logReadTimeout (30 s) = 485 s.
     */
    private static final long LIFECYCLE = 7 * (5_000 + 60_000) + 30_000;

    /**
     * Unité interprétée avec les réglages des tests (attente de file 15 s, per-test-timeout-ms
     * 20 s) : file + max(20 s, 10 s + 5 s) + 75 s de mur du runner + cycle de vie = 595 s.
     */
    private static final long PER_UNIT = 15_000 + 20_000 + 75_000 + LIFECYCLE;
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
    void evaluate_noVerdict_dedicatedException() throws Exception {
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
        // Depuis le runner (#116), le conteneur peut légitimement durer jusqu'à son mur réel :
        // des réglages trop bas (1 ms de base, d'unité et d'attente de file) ne doivent pas
        // pouvoir produire un budget qui abandonne une correction en cours (#216). Les
        // planchers ci-dessous ne dépendent d'aucun réglage ; le calcul exact, terme à terme,
        // est épinglé par readTimeout_includesQuestionTimeLimit. Un stub plus lent que ces
        // planchers n'est pas réaliste ici ; le chemin « délai de lecture dépassé → null, sans
        // nouvel essai » est couvert par evaluate_errorAfterConnect_noRetry, qui surcharge
        // readTimeoutMs pour un budget de 300 ms face à un stub qui répond en 1,5 s.
        ExecutionClient client = client("http://localhost:1", 1, 1, 1);
        // Interprété, une unité : mur du mode exec (temps limite par défaut 10 s + 75 s de
        // WALL_OVERHEAD_MS) + cycle de vie du conteneur hors mur (485 s), quels que soient les
        // réglages : il ne dépend que des bornes d'appel au démon d'execution-service.
        assertThat(client.readTimeoutMs("Python", 1, null))
                .isGreaterThanOrEqualTo(10_000 + 75_000 + LIFECYCLE);
        // Java, 3 cas à trois compilations chacun : 30 s + 3 × (10 + 10 + 3 × 90 + 5) = 915 s,
        // donc le mur du serveur PLAFONNÉ à 15 min, + une fois le cycle de vie du conteneur.
        assertThat(client.readTimeoutMs("Java", 4, null))
                .isGreaterThanOrEqualTo(15 * 60_000 + LIFECYCLE);
    }

    @Test
    @DisplayName("Délai de lecture = base + nombre d'appels × (attente d'une place + exécution), au moins un")
    void readTimeout_couvreAttenteEtAppelParHarnais() {
        // Valeurs DU TEST (pas les défauts) : 10 s de base, per-test-timeout-ms = 20 s, 15 s d'attente de file.
        ExecutionClient client = client("http://localhost:1", 10_000, 20_000, 15_000);

        // Par unité : attente de file (15 s) + max(20 s, temps limite + 5 s) + 75 s de mur
        // du runner (miroir de WALL_OVERHEAD_MS) + cycle de vie du conteneur hors mur (LIFECYCLE).
        // Deux unités au plus : au-delà, le plafond du budget serveur mord (cf.
        // readTimeout_cappedByServerBudget).
        assertThat(client.readTimeoutMs("Python", 1, null)).isEqualTo(10_000 + PER_UNIT);
        assertThat(client.readTimeoutMs("Python", 2, null)).isEqualTo(10_000 + 2 * PER_UNIT);
        assertThat(client.readTimeoutMs("Python", 0, null)).isEqualTo(10_000 + PER_UNIT);
    }

    @Test
    @DisplayName("Le temps limite de la question entre dans le budget par unité dès qu'il dépasse le défaut")
    void readTimeout_includesQuestionTimeLimit() {
        ExecutionClient client = client("http://localhost:1", 10_000, 20_000, 15_000);

        // 60 s de temps limite : chaque unité attend 60 s + 5 s de marge (> 20 s par défaut).
        assertThat(client.readTimeoutMs("Python", 1, 60_000))
                .isEqualTo(10_000 + (65_000 + 75_000 + LIFECYCLE + 15_000));
        // Sous le défaut (10 s + 5 s < 20 s) : le plancher par défaut de l'unité reste.
        assertThat(client.readTimeoutMs("Python", 1, 5_000)).isEqualTo(10_000 + PER_UNIT);
        // Compilé : UNE attente de file + miroir du mur de DockerEvaluator — 30 s de base +
        // (N + 2 canaris) × (run + 10 s de marge + les COMPILATIONS du cas + 5 s d'inventaire
        // `javap`). 4 unités = 1 harnais → 3 cas. La formule est écrite TERME À TERME : tout
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
                .isEqualTo(10_000 + 15_000 + 15 * 60_000 + 5_000 + LIFECYCLE);
        // Plancher VM (10 s) : un temps limite court sur Java ne sous-budgète pas la JVM froide.
        // 30 s + 3 × (10 + 10 + 270 + 5) = 915 s : plafonné de justesse.
        assertThat(client.readTimeoutMs("Java", 4, 1_000))
                .isEqualTo(10_000 + 15_000 + 15 * 60_000 + 5_000 + LIFECYCLE);
        // Nom de langage normalisé comme compiled()/vmLanguage() — la casse, par « Java »
        // ci-dessus, et les espaces ici : « java » entouré d'espaces garde ses TROIS
        // compilations (915 s → plafonné). Sans le trim, il retomberait à deux :
        // 30 s + 3 × (10 + 10 + 180 + 5) = 645 s, un miroir plus court que le mur réel (#216).
        assertThat(client.readTimeoutMs(" java ", 4, 1_000))
                .isEqualTo(10_000 + 15_000 + 15 * 60_000 + 5_000 + LIFECYCLE);
        // Go : DEUX compilations par cas, et non trois — 795 s, sous le plafond.
        assertThat(client.readTimeoutMs("Go", 4, 60_000))
                .isEqualTo(10_000 + 15_000 + 30_000
                        + 3 * (60_000 + 10_000 + 2 * 90_000 + 5_000) + 5_000 + LIFECYCLE);
        // C et C++ : + 30 s d'OUTILS par cas (sondes des noms réservés, `nm`) et + 10 s de
        // préprocesseur par job, miroir de toolsPerCaseMs/toolsPerJobMs de DockerEvaluator —
        // 30 + 10 + 3 × (10 + 10 + 180 + 5 + 30) = 745 s, sous le plafond.
        long cWall = 30_000 + 10_000 + 3 * (10_000 + 10_000 + 2 * 90_000 + 5_000 + 30_000);
        assertThat(client.readTimeoutMs("C++", 4, 10_000))
                .isEqualTo(10_000 + 15_000 + cWall + 5_000 + LIFECYCLE);
        assertThat(client.readTimeoutMs(" c ", 4, 10_000))
                .isEqualTo(10_000 + 15_000 + cWall + 5_000 + LIFECYCLE);
        // Plafonné par le mur du serveur (15 min) : 100 harnais ne donnent plus ~3 h.
        assertThat(client.readTimeoutMs("Java", 202, 60_000))
                .isEqualTo(10_000 + 15_000 + 15 * 60_000 + 5_000 + LIFECYCLE);
        // TypeScript : unité exec ordinaire — les 75 s de mur couvrent la transpilation (60 s).
        assertThat(client.readTimeoutMs("TypeScript", 2, null))
                .isEqualTo(10_000 + 2 * PER_UNIT);
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
        // L'unité de dépassement porte le cycle de vie COMPLET de son conteneur : le budget
        // serveur ne borne que le lancement des harnais, pas la fin de celui qui est en vol.
        long perUnit = PER_UNIT;
        assertThat(client.readTimeoutMs("Python", 100, null))
                .isEqualTo(10_000 + 15 * 60_000 + perUnit);
        // SQL : deux unités par harnais (phases isolées), donc deux unités de dépassement.
        assertThat(client.readTimeoutMs("sql", 200, null))
                .isEqualTo(10_000 + 15 * 60_000 + 2 * perUnit);
        // Bascule : le plafond ne mord qu'au-delà de (budget + 1 unité) / unité ≈ 2,5 unités
        // (595 s par unité avec ces réglages) ; en deçà, la formule par unité reste la référence.
        assertThat(client.readTimeoutMs("Python", 2, null)).isEqualTo(10_000 + 2 * perUnit);
        assertThat(client.readTimeoutMs("Python", 3, null))
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
                .isEqualTo(10_000 + 30 * 60_000 + PER_UNIT);
        // Et un budget serveur ABAISSÉ raccourcit le miroir d'autant (5 min).
        ExecutionClient tight = new ExecutionClient("http://localhost:1", TOKEN, 2_000,
                10_000, 20_000, 15_000, 5 * 60_000);
        assertThat(tight.readTimeoutMs("Python", 100, null))
                .isEqualTo(10_000 + 5 * 60_000 + PER_UNIT);
    }

    /** Port local où RIEN n'écoute : connexion refusée, comme execution-service en redémarrage. */
    private static int closedPort() throws IOException {
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    @Test
    @DisplayName("Service injoignable puis revenu : la connexion est retentée, les verdicts arrivent")
    void evaluate_unreachableThenBack_verdicts() throws Exception {
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
    @DisplayName("Service injoignable plus longtemps : les pauses doublent puis plafonnent à 10 s")
    void evaluate_unreachableLonger_pausesCappedAtMaxDelay() throws Exception {
        // Sans plafond, les pauses montaient à 16, 32, 64 s : un execution-service revenu à
        // t = 20 s n'était recontacté que bien plus tard. Fenêtre de reprise de 60 s (non
        // consommée ici : le sleeper ne dort pas), service revenu pendant la 5e pause.
        int port = closedPort();
        ExecutionClient client = new ExecutionClient("http://localhost:" + port, TOKEN, 2_000,
                5_000, 5_000, 0, 60_000, 60_000);
        List<Long> pauses = new java.util.ArrayList<>();
        client.sleeper = millis -> {
            pauses.add(millis);
            if (pauses.size() == 5) {
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
        assertThat(pauses).containsExactly(1_000L, 2_000L, 4_000L, 8_000L,
                ExecutionClient.RETRY_MAX_DELAY_MS);
    }

    @Test
    @DisplayName("Service injoignable au-delà du budget de reprise → null, pauses bornées")
    void evaluate_unreachableBeyondRetryBudget_null() throws Exception {
        String url = "http://localhost:" + closedPort();
        // Échauffement sans nouvel essai : l'échéance de reprise part AVANT le premier appel, donc
        // l'initialisation à froid du client HTTP (près d'une seconde quand ce test passe en
        // premier dans la JVM) mangeait tout le budget, et aucune pause n'était jamais faite.
        assertThat(new ExecutionClient(url, TOKEN, 2_000, 5_000, 5_000, 0, 60_000, 0)
                .evaluate("Python", "x", TWO_HARNESSES)).isNull();
        long budgetMs = 1_500;
        ExecutionClient client = new ExecutionClient(url, TOKEN, 2_000, 5_000, 5_000, 0, 60_000,
                budgetMs);
        List<Long> pauses = new java.util.ArrayList<>();
        client.sleeper = millis -> {
            pauses.add(millis);
            Thread.sleep(millis);
        };

        assertThat(client.evaluate("Python", "x", TWO_HARNESSES)).isNull();
        assertThat(pauses).isNotEmpty().allMatch(p -> p > 0 && p <= budgetMs);
        assertThat(pauses.stream().mapToLong(Long::longValue).sum()).isLessThanOrEqualTo(budgetMs);
    }

    @Test
    @DisplayName("Interruption pendant l'attente (arrêt de core) → exception dédiée, drapeau rétabli")
    void evaluate_interruptedWhileWaiting_dedicatedException() throws Exception {
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
    void evaluate_errorAfterConnect_noRetry() throws Exception {
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
    @DisplayName("compiled() et vmLanguage() reconnaissent les familles de langages")
    void compiled_recognizesLanguageFamilies() {
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

        // Borne exacte : 0 vaut « défaut du sandbox », pas un temps limite nul.
        client.evaluate("Python", "code", TWO_HARNESSES, 0);
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
    @DisplayName("Unités de travail : un par harnais interprété, deux en SQL (deux phases), 2N + 2 en compilé (compilation + exécution par cas, deux canaris)")
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
}
