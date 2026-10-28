package com.moodit.core_service.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Appelle le service d'EXÉCUTION (sandbox Piston) pour corriger une question Code. Endpoint
 * INTERNE (non exposé par le gateway), authentifié par un jeton partagé {@code X-Internal-Token}.
 * Renvoie le verdict {@code passed} ALIGNÉ sur l'ordre des harnais fournis ; {@code null} si le
 * service est injoignable (le job laisse alors la question « en cours »).
 */
@Component
public class ExecutionClient {

    private static final Logger log = LoggerFactory.getLogger(ExecutionClient.class);

    private final String baseUrl;
    private final String internalToken;
    private final long connectTimeoutMs;
    private final long baseReadTimeoutMs;
    private final long perTestReadTimeoutMs;

    public ExecutionClient(
            @Value("${app.execution-service.internal-url:http://localhost:8084}") String baseUrl,
            @Value("${app.internal.token}") String internalToken,
            @Value("${app.execution-service.connect-timeout-ms:3000}") long connectTimeoutMs,
            @Value("${app.execution-service.read-timeout-ms:10000}") long baseReadTimeoutMs,
            @Value("${app.execution-service.per-test-timeout-ms:${PISTON_HTTP_TIMEOUT_MS:20000}}") long perTestReadTimeoutMs) {
        this.baseUrl = baseUrl;
        this.internalToken = internalToken;
        this.connectTimeoutMs = connectTimeoutMs;
        this.baseReadTimeoutMs = baseReadTimeoutMs;
        this.perTestReadTimeoutMs = perTestReadTimeoutMs;
    }

    /**
     * Délai d'attente de la réponse pour {@code testCount} harnais (#31) : execution-service les
     * exécute L'UN APRÈS L'AUTRE, chacun pouvant prendre jusqu'au délai d'un appel Piston
     * ({@code app.piston.http-timeout-ms}, 20 s par défaut). Le délai par harnais suit donc par
     * défaut {@code PISTON_HTTP_TIMEOUT_MS}, la variable du {@code .env} partagé qui règle ce
     * délai côté execution-service. Un délai fixe faisait échouer la
     * correction d'une question à beaucoup de harnais alors que la sandbox répondait. La correction
     * tourne en tâche de fond : une longue attente ne bloque aucune requête utilisateur.
     */
    long readTimeoutMs(int testCount) {
        return baseReadTimeoutMs + (long) Math.max(testCount, 1) * perTestReadTimeoutMs;
    }

    // Client par appel : le délai de lecture dépend du nombre de harnais. Un sandbox injoignable
    // ou bloqué échoue proprement (→ null) plutôt que de faire traîner le thread indéfiniment.
    private RestClient restClient(int testCount) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofMillis(connectTimeoutMs));
        factory.setReadTimeout(Duration.ofMillis(readTimeoutMs(testCount)));
        return RestClient.builder().requestFactory(factory).build();
    }

    /** Un harnais à exécuter (nom + code + poids). */
    public record Harness(String name, String harnessCode, int weight) {}

    /** Verdict renvoyé par execution-service (on n'exploite que {@code passed} + l'ordre). */
    private record Verdict(String name, int weight, boolean passed, String detail) {}

    /**
     * Exécute {@code code} contre {@code harnesses} dans {@code language} ; renvoie la liste des
     * verdicts (true = réussi) dans le MÊME ordre que {@code harnesses}, ou {@code null} en cas
     * d'échec d'appel.
     */
    public List<Boolean> evaluate(String language, String code, List<Harness> harnesses) {
        Map<String, Object> body = Map.of(
                "language", language == null ? "" : language,
                "code", code == null ? "" : code,
                "testCases", harnesses.stream()
                        .map(h -> Map.of("name", h.name(), "harnessCode", h.harnessCode(), "weight", h.weight()))
                        .toList());
        try {
            Verdict[] verdicts = restClient(harnesses.size()).post()
                    .uri(baseUrl + "/internal/exec/evaluate")
                    .header("X-Internal-Token", internalToken)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .body(Verdict[].class);
            if (verdicts == null) return null;
            return Arrays.stream(verdicts).map(Verdict::passed).toList();
        } catch (RestClientException e) {
            log.warn("Exécution du code (langage {}) échouée : {}", language, e.getMessage());
            return null;
        }
    }
}
