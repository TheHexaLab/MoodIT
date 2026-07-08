package com.moodit.mcp_service.service.mcp;

import com.moodit.mcp_service.dto.McpResponseSummaryDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.util.HashMap;
import java.util.Map;

/**
 * Pont vers le WebSocket de core-service. Le WS (sessions en mémoire) vit dans core-service :
 * mcp-service ne peut pas pousser directement aux clients, il appelle donc un endpoint INTERNE
 * de core-service ({@code /internal/realtime/mcp/...}) qui relaie vers RealtimeEventPublisher.
 * Cet endpoint n'est pas exposé par le gateway ; il est en plus authentifié par un jeton partagé.
 */
@Component
public class McpRealtimeGateway {

    private static final Logger log = LoggerFactory.getLogger(McpRealtimeGateway.class);

    private final RestClient restClient;
    private final String baseUrl;
    private final String internalToken;

    public McpRealtimeGateway(
            @Value("${app.core-service.internal-url:http://localhost:8081}") String baseUrl,
            @Value("${app.internal.token:}") String internalToken) {
        this.baseUrl = baseUrl;
        this.internalToken = internalToken;
        this.restClient = RestClient.create();
    }

    /** Notifie une analyse terminée (→ event WS mcp:analysis-created à la room mcp:<courseId>). */
    public void analysisCreated(long courseId, McpResponseSummaryDto summary) {
        Map<String, Object> body = new HashMap<>();
        body.put("courseId", courseId);
        body.put("id", summary.id());
        body.put("createdAt", summary.createdAt());
        body.put("strengthsCount", summary.strengthsCount());
        body.put("improvementsCount", summary.improvementsCount());
        post("/internal/realtime/mcp/analysis-created", body);
    }

    /** Notifie un échec d'analyse (→ event WS mcp:analysis-failed à la room mcp:<courseId>). */
    public void analysisFailed(long courseId, long userId, String reason) {
        Map<String, Object> body = new HashMap<>();
        body.put("courseId", courseId);
        body.put("userId", userId);
        body.put("reason", reason);
        post("/internal/realtime/mcp/analysis-failed", body);
    }

    /** Notifie l'étape courante d'un job en cours (→ event WS mcp:analysis-progress). */
    public void analysisProgress(long courseId, long userId, String step) {
        Map<String, Object> body = new HashMap<>();
        body.put("courseId", courseId);
        body.put("userId", userId);
        body.put("step", step);
        post("/internal/realtime/mcp/analysis-progress", body);
    }

    private void post(String path, Map<String, Object> body) {
        try {
            restClient.post()
                    .uri(baseUrl + path)
                    .header("X-Internal-Token", internalToken)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientException e) {
            // Le résultat est déjà persisté en base : un push WS raté sera rattrapé par la
            // resync du front à la reconnexion. On loggue sans propager.
            log.warn("Push WS interne vers core-service ({}) échoué : {}", path, e.getMessage());
        }
    }
}
