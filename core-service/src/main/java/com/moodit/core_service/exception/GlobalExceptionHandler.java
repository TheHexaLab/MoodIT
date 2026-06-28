package com.moodit.core_service.exception;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

//Gère toutes les exceptions pour les envoyer au client
//100% géré par Spring
/*
EXCEPTION intéressante de connaitre
-AlreadyExistsException
 */

@RestControllerAdvice
public class GlobalExceptionHandler {

    //Program
    @ExceptionHandler(ProgramNotFoundException.class)
    public ResponseEntity<String> handleProgramNotFound(ProgramNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }

    //Course
    @ExceptionHandler(CourseNotFoundException.class)
    public ResponseEntity<String> handleCourseNotFound(CourseNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }

    //User
    @ExceptionHandler(UserNotFoundException.class)
    public ResponseEntity<String> handleUserNotFound(UserNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }

    //Establishments
    @ExceptionHandler(EstablishmentNotFoundException.class)
    public ResponseEntity<String> handleEstablishmentNotFound(EstablishmentNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }

    //Forum
    @ExceptionHandler(ForumNotFoundException.class)
    public ResponseEntity<String> handleForumNotFound(ForumNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }

    //Post
    @ExceptionHandler(PostNotFoundException.class)
    public ResponseEntity<String> handlePostNotFound(PostNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }

    //Quiz
    @ExceptionHandler(QuizNotFoundException.class)
    public ResponseEntity<String> handleQuizNotFound(QuizNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }

    //Quiz déjà soumis (tentative unique)
    @ExceptionHandler(AlreadySubmittedException.class)
    public ResponseEntity<String> handleAlreadySubmitted(AlreadySubmittedException ex) {
        return ResponseEntity
                .status(HttpStatus.CONFLICT) //Code 409
                .body(ex.getMessage());
    }

    //Tentative introuvable
    @ExceptionHandler(AttemptNotFoundException.class)
    public ResponseEntity<String> handleAttemptNotFound(AttemptNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }
}
