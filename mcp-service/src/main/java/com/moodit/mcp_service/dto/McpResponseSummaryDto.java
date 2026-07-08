package com.moodit.mcp_service.dto;

/**
 * Résumé d'une analyse terminée (historique + payload WebSocket mcp:analysis-created).
 * Volontairement sans `content` (le détail se fetch au clic). Miroir du DTO homonyme de
 * core-service (envoyé tel quel au pont WS interne).
 */
public record McpResponseSummaryDto(
        long id,
        String createdAt,
        int strengthsCount,
        int improvementsCount) {}
