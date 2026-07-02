package com.moodit.mcp_service.service.mcp;

import com.moodit.mcp_service.dto.McpAnalysis;

/**
 * Client d'analyse MCP : transforme le contexte factuel d'un cours en analyse structurée
 * (score, points forts, axes d'amélioration). Implémentation par défaut : appel à un LLM
 * via une API compatible OpenAI (Ollama en local). Lève {@link McpAnalysisException} en cas
 * d'échec — l'appelant ({@link McpAnalysisRunner}) bascule alors sur un repli déterministe.
 */
public interface McpAnalysisClient {
    McpAnalysis analyze(CourseAnalysisContext context);
}
