package com.moodit.mcp_service.service.mcp;

import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;
import com.moodit.mcp_service.repository.McpResponseRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.LocalDateTime;
import java.util.List;

/**
 * Tâche planifiée : passe en FAILED les analyses restées PENDING plus de N minutes pendant que
 * le service tourne (job bloqué ou perdu). Complète {@link McpAnalysisRunner#markRejected}
 * (tâche refusée par l'exécuteur) et {@link McpAnalysisRunner#failOrphanedPending} (redémarrage) :
 * sans elle, le verrou (cours, utilisateur) resterait pris et chaque relance répondrait 409.
 * Le lanceur reçoit le même évènement temps réel qu'un autre échec, ce qui débloque sa popup.
 *
 * <p>Le seuil ({@code app.mcp.pending-timeout-minutes}, 10 par défaut) doit dépasser la durée
 * maximale d'un job : appel LLM (connexion 5 s + lecture {@code app.mcp.llm.timeout-ms}, 60 s par
 * défaut), plus la collecte des statistiques et l'appel de quiz à core-service.
 *
 * <p>{@code created_at} est écrit par la base en UTC (cf. {@code connection-init-sql}) : la date
 * limite est donc calculée sur une horloge UTC, indépendamment du fuseau de la JVM.
 */
@Component
public class StalePendingAnalysisJob {

    private static final Logger log = LoggerFactory.getLogger(StalePendingAnalysisJob.class);

    private final McpResponseRepository mcpResponseRepository;
    private final McpRealtimeGateway realtimeGateway;
    private final Clock clock;
    private final long timeoutMinutes;

    @Autowired
    public StalePendingAnalysisJob(
            McpResponseRepository mcpResponseRepository,
            McpRealtimeGateway realtimeGateway,
            @Value("${app.mcp.pending-timeout-minutes:10}") long timeoutMinutes) {
        this(mcpResponseRepository, realtimeGateway, Clock.systemUTC(), timeoutMinutes);
    }

    /** Horloge injectable pour les tests. */
    StalePendingAnalysisJob(
            McpResponseRepository mcpResponseRepository,
            McpRealtimeGateway realtimeGateway,
            Clock clock,
            long timeoutMinutes) {
        this.mcpResponseRepository = mcpResponseRepository;
        this.realtimeGateway = realtimeGateway;
        this.clock = clock;
        this.timeoutMinutes = timeoutMinutes;
    }

    /**
     * Si un job bloqué finit malgré tout après ce passage, il réécrit sa ligne en DONE : l'analyse
     * apparaît alors dans l'historique (le seuil est choisi pour que ça n'arrive pas en pratique).
     */
    @Scheduled(
            fixedDelayString = "${app.mcp.pending-check-interval-ms:60000}",
            initialDelayString = "${app.mcp.pending-check-interval-ms:60000}")
    @Transactional
    public void failStalePending() {
        LocalDateTime cutoff = LocalDateTime.now(clock).minusMinutes(timeoutMinutes);
        List<McpResponse> stale = mcpResponseRepository.findByStatusAndCreatedAtBefore(McpStatus.PENDING, cutoff);
        if (stale.isEmpty()) return;
        for (McpResponse response : stale) {
            response.setStatus(McpStatus.FAILED);
        }
        mcpResponseRepository.saveAll(stale);
        log.warn("{} analyse(s) MCP en attente depuis plus de {} min passée(s) en FAILED.",
                stale.size(), timeoutMinutes);
        for (McpResponse response : stale) {
            realtimeGateway.analysisFailed(
                    response.getCourse().getId(), response.getUser().getId(), McpAnalysisRunner.UNAVAILABLE);
        }
    }
}
