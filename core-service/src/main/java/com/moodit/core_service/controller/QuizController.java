package com.moodit.core_service.controller;

import com.moodit.core_service.dto.AttemptAcceptedDTO;
import com.moodit.core_service.dto.AttemptStatusDTO;
import com.moodit.core_service.dto.AttemptSummaryDTO;
import com.moodit.core_service.dto.QuizDetailDTO;
import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.dto.ReviewAttemptDTO;
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
     * serveur (submitQuiz), le client n'a donc pas besoin de ces champs. Éléments déplaçables
     * mélangés à chaque envoi, ids publics masqués. Brouillon → 404 (le personnel passe par /edit).
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
     * Statut d'une tentative de l'utilisateur courant sur ce quiz : 200
     * {@code {"status":"pending"|"done"|"review"}}, 404 si elle est absente ou supprimée (correction
     * échouée), d'un autre étudiant ou d'un autre quiz. Le client qui attend une correction s'en
     * sert quand il a pu manquer le verdict WebSocket (reconnexion, rechargement) : la route du
     * résultat répond 404 pendant la correction comme après une suppression. Autorisation en amont
     * par le permission-service (règle GET /quizzes/{quizId}/attempts/{attemptId}/status, celle de
     * l'historique) ; la propriété est vérifiée ici.
     */
    @GetMapping("/{quizId}/attempts/{attemptId}/status")
    public ResponseEntity<AttemptStatusDTO> getAttemptStatus(
            @PathVariable Integer quizId,
            @PathVariable Integer attemptId,
            @RequestHeader("X-User-Email") String email) {
        return ResponseEntity.ok(quizService.getAttemptStatus(quizId, attemptId, email));
    }

    /**
     * Tentatives « à revoir » du quiz, pour l'enseignant (#116, S4) : leur correction a échoué et
     * QuizService les a gardées (relance, ou plafond atteint). Autorisation par rôle assurée en amont par le permission-service
     * (règle GET /quizzes/{quizId}/review-attempts).
     */
    @GetMapping("/{quizId}/review-attempts")
    public ResponseEntity<List<ReviewAttemptDTO>> getAttemptsToReview(@PathVariable Integer quizId) {
        return ResponseEntity.ok(quizService.getAttemptsToReview(quizId));
    }

    /**
     * Relance la correction d'une tentative « à revoir » (#116, S4) : <b>202 Accepted</b>, le
     * résultat part à l'étudiant par WebSocket comme pour une soumission. 404 si la tentative n'est
     * pas de ce quiz, 409 si elle n'est pas à revoir. Autorisation par rôle assurée en amont par le
     * permission-service (règle POST /quizzes/{quizId}/attempts/{attemptId}/regrade).
     */
    @PostMapping("/{quizId}/attempts/{attemptId}/regrade")
    public ResponseEntity<Void> regradeAttempt(
            @PathVariable Integer quizId,
            @PathVariable Integer attemptId) {
        quizService.regradeAttempt(quizId, attemptId);
        return ResponseEntity.accepted().build();
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
     * récupère ensuite via {@code GET /quizzes/{quizId}/attempts/{attemptId}} ; s'il a manqué le
     * verdict, {@code GET …/attempts/{attemptId}/status} dit si la correction est encore en cours
     * (404 : tentative supprimée, la correction a échoué). 409 en JSON
     * {@code {"cause":"en_cours","message":…,"attemptId":…}} si une correction de ce quiz est déjà
     * en cours (le client rejoint l'attente de {@code attemptId}, omis quand la tentative en
     * conflit a disparu), 409 en JSON {@code {"cause":"relance",…}} si c'est l'enseignant qui
     * relance la correction d'une tentative de l'étudiant sur un quiz avec reprise, 409 en texte
     * si la tentative unique est déjà consommée (quiz sans reprise, relance en cours comprise).
     * `X-User-Email` injecté par la gateway.
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
