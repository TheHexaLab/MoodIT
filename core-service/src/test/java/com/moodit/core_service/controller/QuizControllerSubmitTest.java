package com.moodit.core_service.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.exception.AlreadySubmittedException;
import com.moodit.core_service.exception.GradingInProgressException;
import com.moodit.core_service.exception.RegradeInProgressException;
import com.moodit.core_service.service.QuizService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Mapping HTTP de {@code POST /api/quizzes/{id}/submissions}. La soumission est ASYNCHRONE :
 * elle enregistre la tentative et répond <b>202 Accepted</b> avec son id ; la correction du code
 * (et donc l'éventuelle indisponibilité du sandbox) se fait en tâche de fond et remonte par
 * WebSocket, PLUS via HTTP. Restent les trois 409 : « déjà soumis » (texte), « en_cours » et
 * « relance » (JSON) (cf. GlobalExceptionHandler).
 */
@WebMvcTest(controllers = QuizController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class QuizControllerSubmitTest {

    @Autowired private MockMvc mockMvc;

    @MockitoBean private QuizService quizService;

    private static final String BODY = "{\"quizId\":1,\"answers\":[]}";

    @Test
    @DisplayName("Tentative unique déjà consommée → 409, corps texte (pas de cause « en_cours »)")
    void submit_whenAlreadySubmitted_returns409() throws Exception {
        when(quizService.submitQuiz(eq(1), any(QuizSubmissionDTO.class), eq("eva@test.ca")))
                .thenThrow(new AlreadySubmittedException());

        mockMvc.perform(post("/api/quizzes/1/submissions")
                        .header("X-User-Email", "eva@test.ca")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(BODY))
                .andExpect(status().isConflict()) // 409
                .andExpect(content().string("Quiz already submitted"));
    }

    @Test
    @DisplayName("Correction déjà en cours → 409 en JSON {cause: en_cours, message}")
    void submit_whenGradingInProgress_returns409WithCause() throws Exception {
        when(quizService.submitQuiz(eq(1), any(QuizSubmissionDTO.class), eq("eva@test.ca")))
                .thenThrow(new GradingInProgressException());

        mockMvc.perform(post("/api/quizzes/1/submissions")
                        .header("X-User-Email", "eva@test.ca")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(BODY))
                .andExpect(status().isConflict()) // 409
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.cause").value("en_cours"))
                .andExpect(jsonPath("$.message").value("Une correction de ce quiz est déjà en cours."))
                // Tentative en conflit inconnue : pas de champ, le client retombe sur son repli.
                .andExpect(jsonPath("$.attemptId").doesNotExist());
    }

    @Test
    @DisplayName("Correction déjà en cours, tentative connue → 409 en JSON avec son attemptId")
    void submit_whenGradingInProgress_returns409WithAttemptId() throws Exception {
        when(quizService.submitQuiz(eq(1), any(QuizSubmissionDTO.class), eq("eva@test.ca")))
                .thenThrow(new GradingInProgressException(55));

        mockMvc.perform(post("/api/quizzes/1/submissions")
                        .header("X-User-Email", "eva@test.ca")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(BODY))
                .andExpect(status().isConflict()) // 409
                .andExpect(jsonPath("$.cause").value("en_cours"))
                .andExpect(jsonPath("$.attemptId").value(55));
    }

    @Test
    @DisplayName("Relance de l'enseignant en cours → 409 en JSON {cause: relance, message}")
    void submit_whenRegradeInProgress_returns409WithCause() throws Exception {
        when(quizService.submitQuiz(eq(1), any(QuizSubmissionDTO.class), eq("eva@test.ca")))
                .thenThrow(new RegradeInProgressException());

        mockMvc.perform(post("/api/quizzes/1/submissions")
                        .header("X-User-Email", "eva@test.ca")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(BODY))
                .andExpect(status().isConflict()) // 409
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.cause").value("relance"))
                .andExpect(jsonPath("$.message").value("Votre tentative précédente est en cours de"
                        + " recorrection par votre enseignant. Réessayez plus tard."));
    }

    @Test
    @DisplayName("Soumission acceptée → 202 avec l'id de la tentative")
    void submit_whenAccepted_returns202WithAttemptId() throws Exception {
        when(quizService.submitQuiz(eq(1), any(QuizSubmissionDTO.class), eq("eva@test.ca")))
                .thenReturn(42);

        mockMvc.perform(post("/api/quizzes/1/submissions")
                        .header("X-User-Email", "eva@test.ca")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(BODY))
                .andExpect(status().isAccepted()) // 202
                .andExpect(jsonPath("$.attemptId").value(42));
    }
}
