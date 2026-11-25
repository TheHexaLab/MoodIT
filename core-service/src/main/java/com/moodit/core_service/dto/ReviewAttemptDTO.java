package com.moodit.core_service.dto;

import java.time.Instant;

/**
 * Tentative « à revoir » d'un quiz, vue par l'enseignant (#116, S4) : sa correction a échoué et
 * QuizService l'a gardée (plafond d'échecs sans verdict atteint, ou relance de l'enseignant en
 * échec). {@code noVerdictFailures} = échecs sans verdict de l'étudiant sur ce quiz.
 */
public record ReviewAttemptDTO(
        Integer attemptId,
        Integer attemptNo,
        String studentName,
        Instant submittedAt,
        Integer noVerdictFailures) {
}
