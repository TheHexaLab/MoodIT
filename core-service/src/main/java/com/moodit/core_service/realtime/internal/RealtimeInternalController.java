package com.moodit.core_service.realtime.internal;

import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.McpResponseSummaryDto;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Pont WebSocket INTERNE pour les autres microservices (mcp-service). Le WS et son registre
 * de sessions vivent uniquement dans core-service : un service tiers ne peut donc pas pousser
 * directement aux clients. Il appelle ces endpoints, qui relaient vers
 * {@link RealtimeEventPublisher}.
 *
 * <p>Sécurité : ces routes ne sont PAS exposées par le gateway (il ne route que /api, /auth,
 * /mcp, /ws) — inatteignables de l'extérieur. En défense en profondeur, on exige en plus un
 * jeton partagé {@code X-Internal-Token} (= {@code app.internal.token}). Le package `realtime`
 * est exclu du préfixe /api par WebMvcConfig : ces routes restent donc sous /internal.
 */
@RestController
@RequestMapping("/internal/realtime/mcp")
@RequiredArgsConstructor
public class RealtimeInternalController {

    private final RealtimeEventPublisher publisher;

    @Value("${app.internal.token:}")
    private String internalToken;

    /** Relaie mcp:analysis-created à la room mcp:<courseId>. */
    @PostMapping("/analysis-created")
    public ResponseEntity<Void> analysisCreated(
            @RequestHeader(value = "X-Internal-Token", required = false) String token,
            @RequestBody AnalysisCreatedRequest body) {
        if (unauthorized(token)) return ResponseEntity.status(403).build();
        publisher.mcpAnalysisCreated(
                body.courseId(),
                new McpResponseSummaryDto(
                        body.id(), body.createdAt(), body.strengthsCount(), body.improvementsCount()));
        return ResponseEntity.noContent().build();
    }

    /** Relaie mcp:analysis-failed à la room mcp:<courseId>. */
    @PostMapping("/analysis-failed")
    public ResponseEntity<Void> analysisFailed(
            @RequestHeader(value = "X-Internal-Token", required = false) String token,
            @RequestBody AnalysisFailedRequest body) {
        if (unauthorized(token)) return ResponseEntity.status(403).build();
        publisher.mcpAnalysisFailed(body.courseId(), body.userId(), body.reason());
        return ResponseEntity.noContent().build();
    }

    /** Relaie mcp:analysis-progress (étape en cours) à la room mcp:<courseId>. */
    @PostMapping("/analysis-progress")
    public ResponseEntity<Void> analysisProgress(
            @RequestHeader(value = "X-Internal-Token", required = false) String token,
            @RequestBody AnalysisProgressRequest body) {
        if (unauthorized(token)) return ResponseEntity.status(403).build();
        publisher.mcpAnalysisProgress(body.courseId(), body.userId(), body.step());
        return ResponseEntity.noContent().build();
    }

    /** Jeton partagé requis dès qu'il est configuré (vide → contrôle désactivé). */
    private boolean unauthorized(String token) {
        return internalToken != null && !internalToken.isBlank() && !internalToken.equals(token);
    }

    public record AnalysisCreatedRequest(
            long courseId, long id, String createdAt, int strengthsCount, int improvementsCount) {}

    public record AnalysisFailedRequest(long courseId, long userId, String reason) {}

    public record AnalysisProgressRequest(long courseId, long userId, String step) {}
}
