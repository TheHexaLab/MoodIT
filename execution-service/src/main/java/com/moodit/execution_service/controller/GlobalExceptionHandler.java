package com.moodit.execution_service.controller;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.sandbox.NoVerdictException;
import com.moodit.execution_service.sandbox.SandboxException;
import com.moodit.execution_service.service.ExecutionBusyException;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** Traduit les échecs métier/infra en réponses HTTP propres. */
@RestControllerAdvice
public class GlobalExceptionHandler {

    /** Langage pas encore pris en charge → 422 (la requête est valide mais non traitable). */
    @ExceptionHandler(UnsupportedLanguageException.class)
    public ProblemDetail handleUnsupportedLanguage(UnsupportedLanguageException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.UNPROCESSABLE_ENTITY, e.getMessage());
    }

    private static final org.slf4j.Logger LOG =
            org.slf4j.LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /**
     * Sandbox Docker injoignable / en erreur (#116) → 502 (dépendance amont indisponible).
     * La cause est JOURNALISÉE : la réponse reste générique, et sans cette trace une image runner
     * absente ou un démon muet — qui font chacun échouer une correction (tentative supprimée, sauf relance de l'enseignant, ou plafond d'échecs atteint sur un quiz sans reprise, cf. QuizService#failGrading)
     * — ne laissaient rien à l'exploitant pour les distinguer. Un mur dépassé, lui, est un 502
     * « sans verdict » (NoVerdictException, handleNoVerdict).
     */
    @ExceptionHandler(SandboxException.class)
    public ProblemDetail handleSandbox(SandboxException e) {
        LOG.warn("Sandbox d'exécution en échec (502) : {}", e.getMessage(), e);
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_GATEWAY,
                "Sandbox d'exécution indisponible");
        problem.setProperty(CAUSE, UNAVAILABLE);
        return problem;
    }

    /** Propriété du 502 que core lit pour compter les échecs sans verdict (#116, S4). */
    public static final String CAUSE = "cause";
    /** Sandbox injoignable ou en erreur (démon, image, arrêt) : rien n'a tourné, rien ne compte. */
    public static final String UNAVAILABLE = "indisponible";
    /** Le conteneur a tourné sans rendre de verdict : le code soumis a pu y jouer un rôle. */
    public static final String NO_VERDICT = "sans_verdict";

    /**
     * Conteneur runner qui a tourné SANS rendre de verdict → 502 de cause {@code sans_verdict}.
     * Core plafonne ces échecs par étudiant et par quiz ; au-delà, la tentative est gardée « à
     * revoir » par l'enseignant au lieu d'être supprimée (#116, S4).
     */
    @ExceptionHandler(NoVerdictException.class)
    public ProblemDetail handleNoVerdict(NoVerdictException e) {
        LOG.warn("Notation sans verdict (502) : {}", e.getMessage(), e);
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_GATEWAY,
                "Notation sans verdict");
        problem.setProperty(CAUSE, NO_VERDICT);
        return problem;
    }

    /**
     * Sandbox saturé ou trop d'exécutions en cours pour l'utilisateur (#24) → 429, avec un message
     * en français affichable tel quel et un {@code Retry-After} indicatif (secondes).
     */
    @ExceptionHandler(ExecutionBusyException.class)
    public ResponseEntity<ProblemDetail> handleBusy(ExecutionBusyException e) {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .header(HttpHeaders.RETRY_AFTER, "5")
                .body(ProblemDetail.forStatusAndDetail(HttpStatus.TOO_MANY_REQUESTS, e.getMessage()));
    }
}
