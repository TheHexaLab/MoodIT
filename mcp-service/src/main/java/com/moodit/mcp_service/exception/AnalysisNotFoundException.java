package com.moodit.mcp_service.exception;

/** Analyse MCP introuvable (→ 404). */
public class AnalysisNotFoundException extends RuntimeException {
    public AnalysisNotFoundException() {
        super("Analyse introuvable");
    }
}
