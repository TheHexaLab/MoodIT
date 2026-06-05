package com.moodit.core_service.exception;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

//Gère toutes les exceptions pour les envoyer au client
//100% géré par Spring
@RestControllerAdvice
public class GlobalExceptionHandler {

    //Program
    @ExceptionHandler(ProgramNotFoundException.class)
    public ResponseEntity<String> handleProgramNotFound(ProgramNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }
}
