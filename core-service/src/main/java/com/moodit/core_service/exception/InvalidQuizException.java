package com.moodit.core_service.exception;

/**
 * Quiz ou question incohérent à l'enregistrement (ex. question à choix sans aucune bonne réponse).
 * Mappée en HTTP 400 par le GlobalExceptionHandler : la donnée soumise viole une règle du quiz.
 */
public class InvalidQuizException extends RuntimeException {
    public InvalidQuizException(String message) {
        super(message);
    }
}
