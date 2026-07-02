package com.moodit.core_service.exception;

/** Accès refusé : l'utilisateur n'a pas les droits requis (→ 403). */
public class ForbiddenException extends RuntimeException {
    public ForbiddenException() {
        super("Accès refusé");
    }

    public ForbiddenException(String message) {
        super(message);
    }
}
