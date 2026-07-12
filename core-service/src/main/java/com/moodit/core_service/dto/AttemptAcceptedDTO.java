package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Réponse à une soumission de quiz ASYNCHRONE (HTTP 202) : la tentative a été enregistrée en
 * statut « en correction ». Le client attend ensuite le résultat par WebSocket
 * ({@code quiz:attempt-graded} / {@code quiz:attempt-failed}) et le récupère via
 * {@code GET /quizzes/{quizId}/attempts/{attemptId}}.
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class AttemptAcceptedDTO {
    private Integer attemptId;
}
