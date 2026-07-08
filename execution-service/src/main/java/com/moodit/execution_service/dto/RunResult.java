package com.moodit.execution_service.dto;

/**
 * Sortie brute d'une exécution simple ({@link RunRequest}). {@code stdout}/{@code stderr} sont la
 * sortie du programme (stderr porte la stack trace en cas d'exception) ; {@code exitCode} le code
 * de sortie (null si non lancé) ; {@code signal} le signal ayant interrompu le process (ex.
 * SIGKILL au dépassement de temps/mémoire) ; {@code compileOutput} la sortie de compilation pour
 * les langages compilés (null pour Python) ; {@code timedOut} vrai si interrompu par un signal.
 */
public record RunResult(
        String stdout,
        String stderr,
        Integer exitCode,
        String signal,
        String compileOutput,
        boolean timedOut) {}
