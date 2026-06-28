package com.moodit.core_service.exception;

public class AttemptNotFoundException extends RuntimeException {
    public AttemptNotFoundException() {
        super("Attempt not found");
    }
}
