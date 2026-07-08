package com.moodit.mcp_service.exception;

/** Cours introuvable (→ 404). */
public class CourseNotFoundException extends RuntimeException {
    public CourseNotFoundException() {
        super("Cours introuvable");
    }
}
