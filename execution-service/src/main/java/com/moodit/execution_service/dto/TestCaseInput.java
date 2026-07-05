package com.moodit.execution_service.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

/** Un harnais à exécuter contre la soumission (nom affiché + code du harnais + poids). */
public record TestCaseInput(
        @NotBlank String name,
        @NotNull String harnessCode,
        Integer weight) {

    /** Poids effectif : ≥ 1 (défaut 1 si absent/invalide). */
    public int effectiveWeight() {
        return weight != null && weight > 0 ? weight : 1;
    }
}
