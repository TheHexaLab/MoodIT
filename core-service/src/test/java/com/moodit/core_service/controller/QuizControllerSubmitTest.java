package com.moodit.core_service.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.exception.AlreadySubmittedException;
import com.moodit.core_service.exception.CodeVerificationUnavailableException;
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
 * Mapping HTTP de {@code POST /api/quizzes/{id}/submissions} (cf. {@code GlobalExceptionHandler}) :
 * une {@link CodeVerificationUnavailableException} du service (sandbox indisponible) doit ressortir
 * en 503, distincte du 409 « déjà soumis » et du 200 nominal.
 */
@WebMvcTest(controllers = QuizController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class QuizControllerSubmitTest {

    @Autowired private MockMvc mockMvc;

    @MockitoBean private QuizService quizService;

    private static final String BODY = "{\"quizId\":1,\"answers\":[]}";

    @Test
    @DisplayName("Vérification du code indisponible → 503 (tentative non enregistrée)")
    void submit_whenCodeVerificationUnavailable_returns503() throws Exception {
        when(quizService.submitQuiz(eq(1), any(QuizSubmissionDTO.class), eq("eva@test.ca")))
                .thenThrow(new CodeVerificationUnavailableException());

        mockMvc.perform(post("/api/quizzes/1/submissions")
                        .header("X-User-Email", "eva@test.ca")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(BODY))
                .andExpect(status().isServiceUnavailable()); // 503
    }

    @Test
    @DisplayName("Tentative déjà soumise → 409 (inchangé)")
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
    @DisplayName("Soumission valide → 200 avec le résultat corrigé")
    void submit_whenValid_returns200() throws Exception {
        QuizResultDTO result = QuizResultDTO.builder().quizId(1).earned(10.0).max(10.0).build();
        when(quizService.submitQuiz(eq(1), any(QuizSubmissionDTO.class), eq("eva@test.ca")))
                .thenReturn(result);

        mockMvc.perform(post("/api/quizzes/1/submissions")
                        .header("X-User-Email", "eva@test.ca")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(BODY))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.quizId").value(1))
                .andExpect(jsonPath("$.earned").value(10.0));
    }
}
