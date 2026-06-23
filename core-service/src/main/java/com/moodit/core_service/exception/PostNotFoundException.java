package com.moodit.core_service.exception;

public class PostNotFoundException extends RuntimeException{
    public PostNotFoundException() {
        super("Post not found ");
    }
}
