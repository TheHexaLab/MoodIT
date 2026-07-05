package com.moodit.mcp_service.exception;

/** Une analyse MCP est déjà en cours pour ce (cours, utilisateur) (→ 409). */
public class AnalysisAlreadyRunningException extends RuntimeException {
    public AnalysisAlreadyRunningException() {
        super("Une analyse est déjà en cours pour ce cours");
    }
}
