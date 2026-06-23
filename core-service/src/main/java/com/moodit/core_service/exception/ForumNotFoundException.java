package com.moodit.core_service.exception;

public class ForumNotFoundException extends RuntimeException{
    public ForumNotFoundException() {
        super("Forum not found ");
    }
}
