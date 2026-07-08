package com.moodit.core_service.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

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

    private final RestClient restClient;
    private final String baseUrl;
    private final String internalToken;

    public ExecutionClient(
            @Value("${app.execution-service.internal-url:http://localhost:8084}") String baseUrl,
            @Value("${app.internal.token:}") String internalToken) {
        this.baseUrl = baseUrl;
        this.internalToken = internalToken;
        this.restClient = RestClient.create();
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
            Verdict[] verdicts = restClient.post()
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
