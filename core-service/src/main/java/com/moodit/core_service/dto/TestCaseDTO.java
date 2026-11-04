package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

/**
 * Harnais de test (table Test_Case) d'une question Code. RÉSERVÉ à l'éditeur enseignant :
 * jamais renvoyé en passation (le code des tests est caché à l'étudiant).
 */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class TestCaseDTO {
    private Integer id;
    private String name;
    private String harnessCode;
    // Cas structuré (#116) — expression renvoyant la valeur testée + attendu (hors sandbox).
    private String expr;
    private String expectedJson;
    private String compareMode;
    private Integer weight;
}
