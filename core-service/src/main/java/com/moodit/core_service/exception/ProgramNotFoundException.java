package com.moodit.core_service.exception;

public class ProgramNotFoundException extends RuntimeException{
    public ProgramNotFoundException(String code) {
        super("Program not found with code: " + code);
    }
}
