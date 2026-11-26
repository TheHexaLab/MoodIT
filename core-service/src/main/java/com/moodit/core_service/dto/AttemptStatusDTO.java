package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Statut d'une tentative de l'étudiant ({@code GET /quizzes/{quizId}/attempts/{attemptId}/status}) :
 * {@code "pending"} (correction en cours), {@code "done"} (corrigée) ou {@code "review"} (à revoir
 * par l'enseignant, relance en cours comprise). Une tentative supprimée après un échec de
 * correction répond 404 : c'est ce qui distingue « encore en cours » de « échouée » pour un client
 * qui a manqué le verdict WebSocket.
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class AttemptStatusDTO {
    private String status;
}
