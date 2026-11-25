package com.moodit.core_service.exception;

import java.util.Map;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
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

    /**
     * Soumission pendant qu'une correction du même quiz est encore en cours → 409, avec un corps
     * JSON {@code {"cause":"en_cours","message":…}} : la cause permet au frontend de distinguer ce
     * cas du 409 « déjà soumis » (corps texte) et de rejoindre l'attente de la correction.
     */
    @ExceptionHandler(GradingInProgressException.class)
    public ResponseEntity<Map<String, String>> handleGradingInProgress(GradingInProgressException ex) {
        return ResponseEntity
                .status(HttpStatus.CONFLICT) //Code 409
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("cause", GradingInProgressException.CAUSE, "message", ex.getMessage()));
    }

    /**
     * Soumission pendant que l'enseignant RELANCE la correction d'une tentative de l'étudiant → 409,
     * corps JSON {@code {"cause":"relance","message":…}} : le frontend ne doit pas attendre ce
     * verdict comme s'il était celui de la soumission refusée.
     */
    @ExceptionHandler(RegradeInProgressException.class)
    public ResponseEntity<Map<String, String>> handleRegradeInProgress(RegradeInProgressException ex) {
        return ResponseEntity
                .status(HttpStatus.CONFLICT) //Code 409
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("cause", RegradeInProgressException.CAUSE, "message", ex.getMessage()));
    }

    //Relance de correction refusée : tentative pas « à revoir », ou correction déjà en cours (#116, S4)
    @ExceptionHandler(AttemptNotReviewableException.class)
    public ResponseEntity<String> handleAttemptNotReviewable(AttemptNotReviewableException ex) {
        return ResponseEntity
                .status(HttpStatus.CONFLICT) //Code 409
                .body(ex.getMessage());
    }

    // Vérification du code impossible (service d'exécution indisponible). Filet seulement : la
    // correction tourne hors de toute requête HTTP (cf. CodeVerificationUnavailableException), et
    // ce 503 signalerait un échec transitoire côté serveur si l'exception remontait jusqu'ici.
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

    //Contenu de post/message invalide (ex. limite de caractères dépassée) : donnée soumise
    //non conforme → 400 (la requête est mal formée, l'appelant doit corriger sa saisie).
    @ExceptionHandler(InvalidCourseException.class)
    public ResponseEntity<String> handleInvalidCourse(InvalidCourseException ex) {
        return ResponseEntity
                .status(HttpStatus.BAD_REQUEST) //Code 400
                .body(ex.getMessage());
    }

    @ExceptionHandler(InvalidQuizException.class)
    public ResponseEntity<String> handleInvalidQuiz(InvalidQuizException ex) {
        return ResponseEntity
                .status(HttpStatus.BAD_REQUEST) //Code 400
                .body(ex.getMessage());
    }

    @ExceptionHandler(InvalidPostException.class)
    public ResponseEntity<String> handleInvalidPost(InvalidPostException ex) {
        return ResponseEntity
                .status(HttpStatus.BAD_REQUEST) //Code 400
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
