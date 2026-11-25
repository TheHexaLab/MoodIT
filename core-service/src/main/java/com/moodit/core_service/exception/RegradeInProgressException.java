package com.moodit.core_service.exception;

/**
 * Soumission refusée, sur un quiz AVEC reprise, parce que la tentative {@code "pending"} de
 * l'étudiant est une RELANCE de l'enseignant ({@code Attempt.regrade}, #116 S4) et non sa propre
 * correction : il pourra resoumettre une fois la relance finie (« réessayez plus tard »). Sur un
 * quiz SANS reprise, la relance porte forcément sur sa tentative unique : c'est alors
 * {@link AlreadySubmittedException}. Mappée en 409 avec un corps JSON {@code {"cause":"relance", …}}
 * (cf. GlobalExceptionHandler) : distinct de {@link GradingInProgressException}, sans quoi le
 * frontend attendrait un verdict qui n'est pas celui de sa soumission (il retrouve la tentative
 * relancée dans son historique, « à revoir »).
 */
public class RegradeInProgressException extends RuntimeException {

    /** Valeur du champ {@code cause} du corps de la réponse 409, lue par le frontend. */
    public static final String CAUSE = "relance";

    public RegradeInProgressException() {
        super("Votre tentative précédente est en cours de recorrection par votre enseignant."
                + " Réessayez plus tard.");
    }
}
