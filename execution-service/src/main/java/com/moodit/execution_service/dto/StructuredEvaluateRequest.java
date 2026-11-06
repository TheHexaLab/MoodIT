package com.moodit.execution_service.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Évaluation d'une question « appel de fonction » par CAS STRUCTURÉS (#116). Le code étudiant est
 * lancé comme serveur RPC pur (sans harnais ni attendus) ; {@code execution-service} envoie les
 * {@code cases} et compare les sorties aux attendus LUI-MÊME — les attendus ne touchent jamais le
 * sandbox. Remplace le harnais-code pour ces questions (HTML/JSX/SQL gardent un harnais-code).
 */
public record StructuredEvaluateRequest(
        @NotBlank String language,
        String version,
        @NotNull @Size(max = 100_000) String code,
        @NotEmpty @Size(max = 100) List<@Valid StructuredCase> cases,
        /** Temps limite d'exécution demandé par le prof (ms) ; {@code null} → défaut serveur. */
        Integer timeoutMs) {

    /** Constructeur de compatibilité (sans timeout → défaut serveur). */
    public StructuredEvaluateRequest(String language, String version, String code, List<StructuredCase> cases) {
        this(language, version, code, cases, null);
    }
}
