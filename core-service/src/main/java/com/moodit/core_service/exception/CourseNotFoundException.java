package com.moodit.core_service.exception;

public class CourseNotFoundException extends RuntimeException{
    public CourseNotFoundException() {
        super("Course not found ");
    }
}
