package com.moodit.mcp_service.service.mcp;

/** Échec de génération d'une analyse par le LLM (injoignable, 4xx/5xx, JSON illisible…). */
public class McpAnalysisException extends RuntimeException {
    public McpAnalysisException(String message) {
        super(message);
    }

    public McpAnalysisException(String message, Throwable cause) {
        super(message, cause);
    }
}
