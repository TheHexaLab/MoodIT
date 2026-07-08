package com.moodit.execution_service.piston;

/** Échec d'appel au sandbox Piston (injoignable, requête invalide, réponse illisible). */
public class PistonException extends RuntimeException {
    public PistonException(String message) {
        super(message);
    }

    public PistonException(String message, Throwable cause) {
        super(message, cause);
    }
}
