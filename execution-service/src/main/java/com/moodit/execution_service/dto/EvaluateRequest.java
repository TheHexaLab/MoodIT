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
        Integer timeoutMs,
        /**
         * Code de départ de la question, écrit par l'ENSEIGNANT ; {@code null} s'il n'y en a pas.
         * Langages INTERPRÉTÉS seulement (Python, JavaScript, TypeScript, Bash) : une fonction ou
         * une classe qu'il déclare est celle que l'énoncé impose, et peut porter le nom d'une
         * intégrée du langage ({@code sum}, {@code max}, {@code len}…) sans être refusée comme
         * « Nom réservé » (cf. CodeAssembler#notImposed). Les autres langages ne s'en servent
         * pas : en Java, C, C++ et Go, un nom qui masque un outil du harnais est refusé quel que
         * soit le code de départ (le noteur compile ses propres bouchons à ce nom) — l'énoncé y
         * impose donc un autre nom, ce que « Tester » montre au prof ; PHP, Rust et C# n'ont pas
         * ce refus. Jamais fourni par l'étudiant : core le
         * lit dans la question, et la route publique est réservée aux éditeurs de quiz.
         */
        @Size(max = 100_000) String startCode) {

    /** Constructeur de compatibilité (sans timeout → défaut serveur). */
    public EvaluateRequest(String language, String version, String code, List<TestCaseInput> testCases) {
        this(language, version, code, testCases, null, null);
    }

    /** Constructeur de compatibilité (sans code de départ). */
    public EvaluateRequest(String language, String version, String code, List<TestCaseInput> testCases,
            Integer timeoutMs) {
        this(language, version, code, testCases, timeoutMs, null);
    }
}
