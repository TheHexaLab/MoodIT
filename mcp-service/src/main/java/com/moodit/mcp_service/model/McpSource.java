package com.moodit.mcp_service.model;

/**
 * Origine du contenu d'une analyse MCP (colonne mcp_response.source).
 * LLM           : analyse rédigée par le modèle de langage.
 * DETERMINISTIC : repli calculé sans IA à partir des statistiques du cours (LLM injoignable,
 *                 clé absente ou réponse illisible).
 * Null tant que l'analyse n'est pas terminée, et pour les analyses antérieures à la colonne.
 */
public enum McpSource {
    LLM,
    DETERMINISTIC
}
