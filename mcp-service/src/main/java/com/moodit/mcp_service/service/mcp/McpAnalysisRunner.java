package com.moodit.mcp_service.service.mcp;

import tools.jackson.databind.ObjectMapper;
import com.moodit.mcp_service.dto.McpAnalysis;
import com.moodit.mcp_service.dto.McpResponseSummaryDto;
import com.moodit.mcp_service.model.Course;
import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;
import com.moodit.mcp_service.repository.CourseStatsRepository;
import com.moodit.mcp_service.repository.McpResponseRepository;
import com.moodit.mcp_service.util.Timestamps;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

/**
 * Exécute le job d'analyse MCP EN ARRIÈRE-PLAN (bean séparé : le proxy @Async ne s'applique
 * pas à un appel intra-classe). Reprend la ligne `pending` créée par McpService, agrège le
 * contexte réel du cours, appelle le LLM (Ollama) et — EN CAS D'ÉCHEC — bascule sur le repli
 * déterministe pour que l'analyse aboutisse quand même. Met à jour la ligne (DONE) et POUSSE
 * le résultat via le WS de core-service (pont interne).
 */
@Component
@RequiredArgsConstructor
public class McpAnalysisRunner {

    private static final Logger log = LoggerFactory.getLogger(McpAnalysisRunner.class);

    private final McpResponseRepository mcpResponseRepository;
    private final CourseStatsRepository courseStatsRepository;
    private final CoreQuizStatsClient coreQuizStatsClient;
    private final McpAnalysisClient analysisClient;
    private final McpRealtimeGateway realtimeGateway;
    private final ObjectMapper objectMapper;

    @Async("mcpExecutor")
    public void run(Integer responseId) {
        McpResponse response = mcpResponseRepository.findById(responseId).orElse(null);
        if (response == null) return; // supprimée entre-temps : rien à faire

        Course course = response.getCourse();
        int courseId = course.getId();
        int userId = response.getUser().getId();

        try {
            // Feedback temps réel : le front (lanceur) affiche l'étape courante pendant l'attente.
            realtimeGateway.analysisProgress(courseId, userId, "collecting");
            CourseAnalysisContext ctx = new CourseAnalysisContext(
                    courseId,
                    course.getTitle(),
                    course.getCode(),
                    courseStatsRepository.countQuizzes(courseId),
                    courseStatsRepository.countForumMessages(courseId),
                    courseStatsRepository.countStudents(courseId),
                    courseStatsRepository.sampleForumMessages(courseId, 20),
                    courseStatsRepository.countQuizAttempts(courseId),
                    courseStatsRepository.countDistinctQuizStudents(courseId),
                    courseStatsRepository.codeTestPassRate(courseId),
                    // Réussite réelle aux quiz auto-corrigés, calculée par core (jamais stockée).
                    coreQuizStatsClient.averageScorePercent(courseId));

            McpAnalysis analysis;
            try {
                realtimeGateway.analysisProgress(courseId, userId, "analyzing");
                analysis = analysisClient.analyze(ctx);
            } catch (McpAnalysisException e) {
                // LLM indisponible/illisible : on n'échoue PAS le job, on calcule un repli
                // déterministe à partir des stats réelles (sécurise la démo).
                log.warn("LLM indisponible pour l'analyse #{} (cours {}) : {} — repli déterministe.",
                        responseId, courseId, e.getMessage());
                realtimeGateway.analysisProgress(courseId, userId, "fallback");
                analysis = DeterministicMcpAnalysis.compute(ctx);
            }

            response.setContent(objectMapper.writeValueAsString(analysis));
            response.setStatus(McpStatus.DONE);
            mcpResponseRepository.save(response);

            realtimeGateway.analysisCreated(
                    courseId,
                    new McpResponseSummaryDto(
                            response.getId(),
                            Timestamps.isoUtc(response.getCreatedAt()),
                            analysis.strengths().size(),
                            analysis.improvements().size()));
        } catch (Exception e) {
            // Erreur inattendue (base, sérialisation…) : marque FAILED et notifie l'échec.
            log.warn("Analyse MCP #{} (cours {}) échouée : {}", responseId, courseId, e.getMessage());
            response.setStatus(McpStatus.FAILED);
            mcpResponseRepository.save(response);
            realtimeGateway.analysisFailed(courseId, userId, e.getMessage());
        }
    }
}
