package com.moodit.core_service.exception;

import org.springframework.dao.DataIntegrityViolationException;
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

    //Vérification du code impossible (service d'exécution indisponible) : la tentative n'a pas
    //été enregistrée, l'étudiant peut renvoyer. 503 pour signaler un échec transitoire côté serveur.
    @ExceptionHandler(CodeVerificationUnavailableException.class)
    public ResponseEntity<String> handleCodeVerificationUnavailable(CodeVerificationUnavailableException ex) {
        return ResponseEntity
                .status(HttpStatus.SERVICE_UNAVAILABLE) //Code 503
                .body(ex.getMessage());
    }

    //Tentative introuvable
    @ExceptionHandler(AttemptNotFoundException.class)
    public ResponseEntity<String> handleAttemptNotFound(AttemptNotFoundException ex) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND) //Code 404
                .body(ex.getMessage());
    }

    //Accès refusé (droits insuffisants, ex. détail d'édition d'un quiz réservé aux admins)
    @ExceptionHandler(ForbiddenException.class)
    public ResponseEntity<String> handleForbidden(ForbiddenException ex) {
        return ResponseEntity
                .status(HttpStatus.FORBIDDEN) //Code 403
                .body(ex.getMessage());
    }

    //Violation d'une contrainte BD (UNIQUE, CHECK…) : ex. domaine d'établissement déjà utilisé.
    //Renvoie 409 (au lieu de laisser l'exception non gérée finir en 404/500).
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<String> handleDataIntegrity(DataIntegrityViolationException ex) {
        return ResponseEntity
                .status(HttpStatus.CONFLICT) //Code 409
                .body("Contrainte non respectée : cette valeur existe déjà ou est invalide.");
    }
}
