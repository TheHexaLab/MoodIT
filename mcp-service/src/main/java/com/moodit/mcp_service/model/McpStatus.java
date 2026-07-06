package com.moodit.mcp_service.model;

/**
 * Statut d'une analyse MCP (colonne mcp_response.status).
 * PENDING : job en cours (content null) — sert de verrou (cours, user).
 * DONE    : analyse terminée (seul statut listé dans l'historique).
 * FAILED  : job échoué (content null). Rare : le runner bascule d'abord sur un repli
 *           déterministe, donc FAILED ne survient que sur erreur inattendue (ex. base).
 */
public enum McpStatus {
    PENDING,
    DONE,
    FAILED
}
