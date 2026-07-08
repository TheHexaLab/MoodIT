package com.moodit.mcp_service.exception;

/** Utilisateur introuvable (→ 404). */
public class UserNotFoundException extends RuntimeException {
    public UserNotFoundException() {
        super("Utilisateur introuvable");
    }
}
