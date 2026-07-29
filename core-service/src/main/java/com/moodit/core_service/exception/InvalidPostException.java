package com.moodit.core_service.exception;

/**
 * Contenu de post/message invalide (ex. dépassement de la limite de caractères). Mappée en
 * HTTP 400 par le GlobalExceptionHandler. Distincte des *NotFoundException (404) : ici la
 * ressource est valide mais la donnée soumise ne respecte pas une contrainte de saisie.
 */
public class InvalidPostException extends RuntimeException {
    public InvalidPostException(String message) {
        super(message);
    }
}
