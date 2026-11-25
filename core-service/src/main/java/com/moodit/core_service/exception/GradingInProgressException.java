package com.moodit.core_service.exception;

/**
 * Soumission refusée parce qu'une correction d'une soumission de l'étudiant sur ce quiz est en
 * cours. Levée dans deux cas : une tentative {@code "pending"} ordinaire (pas une relance de
 * l'enseignant) existe déjà ; ou l'insert de la tentative a heurté une écriture CONCURRENTE du
 * même étudiant ({@code UNIQUE(quiz,user,attempt_no)} ou index partiel {@code uq_attempt_pending}),
 * même si le pending concurrent est déjà corrigé ou supprimé quand on relit. Mappée en 409 avec
 * un corps JSON {@code {"cause":"en_cours", …}} (cf. GlobalExceptionHandler), distinct du 409
 * « tentative unique déjà consommée » ({@link AlreadySubmittedException}, corps texte) : le
 * frontend rejoint alors l'attente de la correction en cours au lieu d'afficher « déjà soumis ».
 */
public class GradingInProgressException extends RuntimeException {

    /** Valeur du champ {@code cause} du corps de la réponse 409, lue par le frontend. */
    public static final String CAUSE = "en_cours";

    public GradingInProgressException() {
        super("Une correction de ce quiz est déjà en cours.");
    }
}
