package com.moodit.core_service.exception;

public class AlreadySubmittedException extends RuntimeException {
    public AlreadySubmittedException() {
        super("Quiz already submitted");
    }
}
