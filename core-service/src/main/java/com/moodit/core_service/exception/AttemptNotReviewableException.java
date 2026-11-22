package com.moodit.core_service.exception;

/**
 * Relance de correction refusée (#116, S4) : la tentative n'est pas « à revoir », ou l'étudiant a
 * déjà une correction en cours sur ce quiz. Mappée en 409.
 */
public class AttemptNotReviewableException extends RuntimeException {
    public AttemptNotReviewableException() {
        super("Attempt is not awaiting review");
    }
}
