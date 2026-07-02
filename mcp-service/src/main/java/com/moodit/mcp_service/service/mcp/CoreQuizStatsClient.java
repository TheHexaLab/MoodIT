package com.moodit.mcp_service.service.mcp;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * Récupère la réussite aux quiz d'un cours auprès de core-service (endpoint interne). Le score
 * des quiz n'est PAS stocké : core le recalcule à la volée avec sa logique de correction. On
 * évite ainsi de dupliquer la notation dans mcp-service. Échec / indisponible → {@code null}
 * (le contexte le signalera comme « non disponible » au LLM).
 */
@Component
public class CoreQuizStatsClient {

    private static final Logger log = LoggerFactory.getLogger(CoreQuizStatsClient.class);

    private final RestClient restClient;
    private final String baseUrl;
    private final String internalToken;

    public CoreQuizStatsClient(
            @Value("${app.core-service.internal-url:http://localhost:8081}") String baseUrl,
            @Value("${app.internal.token:}") String internalToken) {
        this.baseUrl = baseUrl;
        this.internalToken = internalToken;
        this.restClient = RestClient.create();
    }

    /** Score moyen (%) aux quiz AUTO-corrigés du cours ; {@code null} si aucun ou en cas d'échec. */
    public Integer averageScorePercent(int courseId) {
        try {
            Stats stats = restClient.get()
                    .uri(baseUrl + "/internal/quiz-stats/course/" + courseId)
                    .header("X-Internal-Token", internalToken)
                    .retrieve()
                    .body(Stats.class);
            return stats == null ? null : stats.averageScorePercent();
        } catch (RestClientException e) {
            log.warn("Réussite quiz (cours {}) indisponible : {}", courseId, e.getMessage());
            return null;
        }
    }

    /** Miroir de core CourseQuizStatsDTO (seul averageScorePercent est exploité ici). */
    record Stats(Integer averageScorePercent, int gradedAttemptCount, int studentCount) {}
}
