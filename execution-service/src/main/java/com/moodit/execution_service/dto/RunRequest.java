package com.moodit.execution_service.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

/**
 * Demande d'EXÉCUTION simple d'un code (bouton « play » des éditeurs de quiz : côté étudiant et
 * onglet « Tester »). Contrairement à {@link EvaluateRequest}, aucun harnais : on lance le code
 * tel quel dans le sandbox et on renvoie sa sortie brute (stdout/stderr/exit) — utile pour
 * déboguer avant de soumettre. Aucune persistance.
 */
public record RunRequest(
        @NotBlank String language,
        String version,
        @NotNull String code) {}
