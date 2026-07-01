package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.Instant;

/** Résumé d'une tentative de quiz (pour l'historique côté étudiant). */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class AttemptSummaryDTO {
    private Integer id;
    private Integer attemptNo;
    private Integer earned;
    private Integer max;
    private Instant submittedAt;
}
