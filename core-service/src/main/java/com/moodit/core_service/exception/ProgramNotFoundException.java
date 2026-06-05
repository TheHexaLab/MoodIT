package com.moodit.core_service.exception;

public class ProgramNotFoundException extends RuntimeException{
    public ProgramNotFoundException() {
        super("Program not found with code: ");
    }
}
