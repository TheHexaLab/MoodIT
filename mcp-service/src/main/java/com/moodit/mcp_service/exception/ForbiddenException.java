package com.moodit.mcp_service.exception;

/** Accès refusé : droits insuffisants (réservé aux administrateurs) (→ 403). */
public class ForbiddenException extends RuntimeException {
    public ForbiddenException() {
        super("Accès refusé");
    }
}
