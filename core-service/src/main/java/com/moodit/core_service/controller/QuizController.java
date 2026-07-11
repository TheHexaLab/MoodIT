package com.moodit.core_service.controller;

import com.moodit.core_service.dto.AttemptAcceptedDTO;
import com.moodit.core_service.dto.AttemptSummaryDTO;
import com.moodit.core_service.dto.QuizDetailDTO;
import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.service.QuizService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/quizzes") // /api/quizzes (préfixe /api ajouté par WebMvcConfig)
@RequiredArgsConstructor
public class QuizController {

    private final QuizService quizService;

    /**
     * Détail d'un quiz pour la PASSATION (étudiant) : SANS les champs de correction
     * (isCorrect/correctOrder/groupName) ni les harnais. La correction est faite côté
     * serveur (submitQuiz), le client n'a donc pas besoin de ces champs.
     */
    @GetMapping("/{quizId}")
    public ResponseEntity<QuizDetailDTO> getQuizDetail(@PathVariable Integer quizId) {
        return ResponseEntity.ok(quizService.getQuizDetail(quizId));
    }

    /**
     * Détail complet d'un quiz pour l'ÉDITEUR enseignant : AVEC la correction. Autorisation par
     * rôle assurée en amont par le permission-service (règle GET /quizzes/{quizId}/edit).
     */
    @GetMapping("/{quizId}/edit")
    public ResponseEntity<QuizDetailDTO> getQuizForEdit(@PathVariable Integer quizId) {
        return ResponseEntity.ok(quizService.getQuizForEdit(quizId));
    }

    /** Historique des tentatives de l'utilisateur courant sur ce quiz (résumés). */
    @GetMapping("/{quizId}/attempts")
    public ResponseEntity<List<AttemptSummaryDTO>> getMyAttempts(
            @PathVariable Integer quizId,
            @RequestHeader("X-User-Email") String email) {
        return ResponseEntity.ok(quizService.getMyAttempts(quizId, email));
    }

    /** Détail corrigé d'une tentative donnée (révision), restreint à son propriétaire. */
    @GetMapping("/{quizId}/attempts/{attemptId}")
    public ResponseEntity<QuizResultDTO> getAttemptResult(
            @PathVariable Integer quizId,
            @PathVariable Integer attemptId,
            @RequestHeader("X-User-Email") String email) {
        return ResponseEntity.ok(quizService.getAttemptResult(attemptId, email));
    }

    /**
     * Met à jour un quiz complet (méta + questions) en un appel. Autorisation par rôle assurée en
     * amont par le permission-service (règle PUT /quizzes/{quizId}).
     */
    @PutMapping("/{quizId}")
    public ResponseEntity<QuizDetailDTO> updateQuiz(
            @PathVariable Integer quizId,
            @RequestBody QuizDetailDTO request) {
        return ResponseEntity.ok(quizService.updateQuiz(quizId, request));
    }

    /**
     * Supprime un quiz et tout son contenu (cascade). Autorisation par rôle assurée en amont par
     * le permission-service (règle DELETE /quizzes/{quizId}).
     */
    @DeleteMapping("/{quizId}")
    public ResponseEntity<Void> deleteQuiz(@PathVariable Integer quizId) {
        quizService.deleteQuiz(quizId);
        return ResponseEntity.noContent().build();
    }

    /**
     * Soumet une tentative de façon ASYNCHRONE : le serveur enregistre la tentative et répond
     * <b>202 Accepted</b> avec son id, puis corrige le code en tâche de fond. Le résultat arrive
     * par WebSocket ({@code quiz:attempt-graded} / {@code quiz:attempt-failed}) ; le client le
     * récupère ensuite via {@code GET /quizzes/{quizId}/attempts/{attemptId}}. Tentative unique →
     * 409 si déjà soumis ou déjà en cours de correction. `X-User-Email` injecté par la gateway.
     */
    @PostMapping("/{quizId}/submissions")
    public ResponseEntity<AttemptAcceptedDTO> submitQuiz(
            @PathVariable Integer quizId,
            @RequestBody QuizSubmissionDTO submission,
            @RequestHeader("X-User-Email") String email) {
        Integer attemptId = quizService.submitQuiz(quizId, submission, email);
        return ResponseEntity.accepted().body(new AttemptAcceptedDTO(attemptId));
    }
}
