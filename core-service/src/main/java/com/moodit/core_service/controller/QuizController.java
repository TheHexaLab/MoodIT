package com.moodit.core_service.controller;

import com.moodit.core_service.dto.QuizDetailDTO;
import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.service.QuizService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/quizzes") // /api/quizzes (préfixe /api ajouté par WebMvcConfig)
@RequiredArgsConstructor
public class QuizController {

    private final QuizService quizService;

    /** Détail d'un quiz (méta + questions embarquées) pour la passation/édition. */
    @GetMapping("/{quizId}")
    public ResponseEntity<QuizDetailDTO> getQuizDetail(@PathVariable Integer quizId) {
        return ResponseEntity.ok(quizService.getQuizDetail(quizId));
    }

    /**
     * Résultat de la tentative déjà soumise par l'utilisateur courant (réhydratation :
     * le front affiche le récap au lieu de laisser refaire le quiz). 204 si pas soumis.
     */
    @GetMapping("/{quizId}/submissions/me")
    public ResponseEntity<QuizResultDTO> getMyResult(
            @PathVariable Integer quizId,
            @RequestHeader("X-User-Email") String email) {
        QuizResultDTO result = quizService.getMyResult(quizId, email);
        return result == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(result);
    }

    /** Met à jour un quiz complet (méta + questions) en un appel. */
    @PutMapping("/{quizId}")
    public ResponseEntity<QuizDetailDTO> updateQuiz(
            @PathVariable Integer quizId,
            @RequestBody QuizDetailDTO request) {
        return ResponseEntity.ok(quizService.updateQuiz(quizId, request));
    }

    /** Supprime un quiz et tout son contenu (cascade). */
    @DeleteMapping("/{quizId}")
    public ResponseEntity<Void> deleteQuiz(@PathVariable Integer quizId) {
        quizService.deleteQuiz(quizId);
        return ResponseEntity.noContent().build();
    }

    /**
     * Soumet une tentative ; le serveur corrige (sauf code), persiste les soumissions et
     * renvoie le résultat. Tentative unique → 409 si déjà soumis. `X-User-Email` injecté
     * par la gateway (issu du JWT).
     */
    @PostMapping("/{quizId}/submissions")
    public ResponseEntity<QuizResultDTO> submitQuiz(
            @PathVariable Integer quizId,
            @RequestBody QuizSubmissionDTO submission,
            @RequestHeader("X-User-Email") String email) {
        return ResponseEntity.ok(quizService.submitQuiz(quizId, submission, email));
    }
}
