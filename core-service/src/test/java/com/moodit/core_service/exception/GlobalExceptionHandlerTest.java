package com.moodit.core_service.exception;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * Traduction des exceptions métier en réponses HTTP par {@link GlobalExceptionHandler} : chaque
 * exception a SON code (404 / 409 / 503 / 403 / 400) et renvoie son message en corps, sauf la
 * violation de contrainte BD dont le message technique est remplacé par un libellé générique.
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    private static void assertResponse(ResponseEntity<String> r, HttpStatus status, String body) {
        assertThat(r.getStatusCode()).isEqualTo(status);
        assertThat(r.getBody()).isEqualTo(body);
    }

    @Test
    @DisplayName("Ressources introuvables → 404 avec le message de l'exception")
    void introuvables_404() {
        assertResponse(handler.handleProgramNotFound(new ProgramNotFoundException()),
                HttpStatus.NOT_FOUND, "Program not found ");
        assertResponse(handler.handleCourseNotFound(new CourseNotFoundException()),
                HttpStatus.NOT_FOUND, "Course not found ");
        assertResponse(handler.handleUserNotFound(new UserNotFoundException()),
                HttpStatus.NOT_FOUND, "User not found ");
        assertResponse(handler.handleEstablishmentNotFound(new EstablishmentNotFoundException()),
                HttpStatus.NOT_FOUND, "Establishments not found");
        assertResponse(handler.handleForumNotFound(new ForumNotFoundException()),
                HttpStatus.NOT_FOUND, "Forum not found ");
        assertResponse(handler.handlePostNotFound(new PostNotFoundException()),
                HttpStatus.NOT_FOUND, "Post not found ");
        assertResponse(handler.handleQuizNotFound(new QuizNotFoundException()),
                HttpStatus.NOT_FOUND, "Quiz not found");
        assertResponse(handler.handleAttemptNotFound(new AttemptNotFoundException()),
                HttpStatus.NOT_FOUND, "Attempt not found");
    }

    @Test
    @DisplayName("Quiz déjà soumis (tentative unique) → 409")
    void dejaSoumis_409() {
        assertResponse(handler.handleAlreadySubmitted(new AlreadySubmittedException()),
                HttpStatus.CONFLICT, "Quiz already submitted");
    }

    @Test
    @DisplayName("Vérification du code indisponible → 503 (échec transitoire)")
    void verificationIndisponible_503() {
        assertResponse(handler.handleCodeVerificationUnavailable(new CodeVerificationUnavailableException()),
                HttpStatus.SERVICE_UNAVAILABLE, "Code verification unavailable");
    }

    @Test
    @DisplayName("Accès refusé → 403 avec le message fourni (ou le libellé par défaut)")
    void accesRefuse_403() {
        assertResponse(handler.handleForbidden(new ForbiddenException("Réservé aux enseignants")),
                HttpStatus.FORBIDDEN, "Réservé aux enseignants");
        assertResponse(handler.handleForbidden(new ForbiddenException()),
                HttpStatus.FORBIDDEN, "Accès refusé");
    }

    @Test
    @DisplayName("Contenu de post invalide → 400 avec le message")
    void postInvalide_400() {
        assertResponse(handler.handleInvalidPost(new InvalidPostException("Trop long")),
                HttpStatus.BAD_REQUEST, "Trop long");
    }

    @Test
    @DisplayName("Violation de contrainte BD → 409 avec un libellé générique (pas de fuite SQL)")
    void contrainteBd_409_libelleGenerique() {
        ResponseEntity<String> r = handler.handleDataIntegrity(
                new DataIntegrityViolationException("duplicate key value violates unique constraint uq_domain"));

        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(r.getBody())
                .isEqualTo("Contrainte non respectée : cette valeur existe déjà ou est invalide.")
                .doesNotContain("uq_domain");
    }
}
