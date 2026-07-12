package com.moodit.execution_service.controller;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.piston.PistonException;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
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

    /** Sandbox injoignable / en erreur → 502 (dépendance amont indisponible). */
    @ExceptionHandler(PistonException.class)
    public ProblemDetail handlePiston(PistonException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_GATEWAY,
                "Sandbox d'exécution indisponible");
    }
}
