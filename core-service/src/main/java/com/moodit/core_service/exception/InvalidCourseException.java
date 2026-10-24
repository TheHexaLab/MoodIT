package com.moodit.core_service.exception;

/**
 * Modification de cours incohérente (ex. retirer le cours de tous ses programmes). Mappée en
 * HTTP 400 par le GlobalExceptionHandler : la donnée soumise viole une règle du cours.
 */
public class InvalidCourseException extends RuntimeException {
    public InvalidCourseException(String message) {
        super(message);
    }
}
