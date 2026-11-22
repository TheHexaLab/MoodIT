package com.moodit.core_service.dto;

import java.time.Instant;

/**
 * Tentative « à revoir » d'un quiz, vue par l'enseignant (#116, S4) : sa correction a échoué sans
 * verdict au-delà du plafond. {@code noVerdictFailures} = échecs sans verdict de l'étudiant sur ce
 * quiz.
 */
public record ReviewAttemptDTO(
        Integer attemptId,
        Integer attemptNo,
        String studentName,
        Instant submittedAt,
        Integer noVerdictFailures) {
}
