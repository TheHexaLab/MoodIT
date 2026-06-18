package com.moodit.core_service.exception;

public class UserNotFoundException extends RuntimeException{
    public UserNotFoundException() {
        super("User not found ");
    }
}
