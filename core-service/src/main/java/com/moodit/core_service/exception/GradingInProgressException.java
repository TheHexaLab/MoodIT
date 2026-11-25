package com.moodit.core_service.exception;

/**
 * Soumission refusée parce que l'étudiant a DÉJÀ une tentative {@code "pending"} sur ce quiz : sa
 * correction précédente est encore en cours (index partiel {@code uq_attempt_pending}). Mappée en
 * 409 avec un corps JSON {@code {"cause":"en_cours", …}} (cf. GlobalExceptionHandler), distinct du
 * 409 « tentative unique déjà consommée » ({@link AlreadySubmittedException}, corps texte) : le
 * frontend rejoint alors l'attente de la correction en cours au lieu d'afficher « déjà soumis ».
 */
public class GradingInProgressException extends RuntimeException {

    /** Valeur du champ {@code cause} du corps de la réponse 409, lue par le frontend. */
    public static final String CAUSE = "en_cours";

    public GradingInProgressException() {
        super("Une correction de ce quiz est déjà en cours.");
    }
}
