package com.moodit.core_service.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.exception.AlreadySubmittedException;
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
 * WebSocket, PLUS via HTTP. Reste le 409 « déjà soumis / déjà en cours » (cf. GlobalExceptionHandler).
 */
@WebMvcTest(controllers = QuizController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class QuizControllerSubmitTest {

    @Autowired private MockMvc mockMvc;

    @MockitoBean private QuizService quizService;

    private static final String BODY = "{\"quizId\":1,\"answers\":[]}";

    @Test
    @DisplayName("Tentative déjà soumise (ou déjà en cours de correction) → 409")
    void submit_whenAlreadySubmitted_returns409() throws Exception {
        when(quizService.submitQuiz(eq(1), any(QuizSubmissionDTO.class), eq("eva@test.ca")))
                .thenThrow(new AlreadySubmittedException());

        mockMvc.perform(post("/api/quizzes/1/submissions")
                        .header("X-User-Email", "eva@test.ca")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(BODY))
                .andExpect(status().isConflict()); // 409
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
