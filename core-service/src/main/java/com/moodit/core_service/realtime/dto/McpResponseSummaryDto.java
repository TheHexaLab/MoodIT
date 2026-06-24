// Résumé d'une analyse MCP poussé en temps réel (scope = cours). Reproduit
// EXACTEMENT `McpResponseSummary` du front (frontend/src/types/domain.ts) : on
// pousse le RÉSUMÉ (compteurs), sans le `content` — le détail se fetch au clic.

package com.moodit.core_service.realtime.dto;

public record McpResponseSummaryDto(
    long id,
    String createdAt,
    int strengthsCount,
    int improvementsCount) {}
