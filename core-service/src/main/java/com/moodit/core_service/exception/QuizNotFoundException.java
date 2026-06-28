package com.moodit.core_service.exception;

public class QuizNotFoundException extends RuntimeException {
    public QuizNotFoundException() {
        super("Quiz not found");
    }
}
