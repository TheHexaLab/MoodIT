package com.moodit.execution_service.controller;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
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
     * absente, un mur dépassé ou un démon muet — qui suppriment chacun une tentative — ne
     * laissaient rien à l'exploitant pour les distinguer.
     */
    @ExceptionHandler(SandboxException.class)
    public ProblemDetail handleSandbox(SandboxException e) {
        LOG.warn("Sandbox d'exécution en échec (502) : {}", e.getMessage(), e);
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_GATEWAY,
                "Sandbox d'exécution indisponible");
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
