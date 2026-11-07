package com.moodit.execution_service.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Demande d'évaluation d'une question Code (bouton « Tester » de l'éditeur, sans persistance).
 * {@code language} = nom du langage de la question (ex. « Python »). {@code code} = source de
 * l'étudiant/prof à tester contre chaque harnais. Le langage DU HARNAIS peut différer (résolu
 * plus tard via harness_language_id) — géré côté assemblage. Bornes anti-DoS sur la taille du
 * code et le nombre de harnais.
 */
public record EvaluateRequest(
        @NotBlank String language,
        String version,
        @NotNull @Size(max = 100_000) String code,
        @NotEmpty @Size(max = 100) List<@Valid TestCaseInput> testCases,
        /** Temps limite d'exécution demandé par le prof (ms) ; {@code null} → défaut serveur.
         *  Borné côté {@link com.moodit.execution_service.sandbox.RunnerExec} (MAX_RUN_TIMEOUT_MS). */
        Integer timeoutMs) {

    /** Constructeur de compatibilité (sans timeout → défaut serveur). */
    public EvaluateRequest(String language, String version, String code, List<TestCaseInput> testCases) {
        this(language, version, code, testCases, null);
    }
}
