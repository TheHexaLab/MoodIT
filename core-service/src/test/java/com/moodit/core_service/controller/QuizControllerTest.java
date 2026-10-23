package com.moodit.core_service.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.AnswerDTO;
import com.moodit.core_service.dto.AttemptSummaryDTO;
import com.moodit.core_service.dto.QuestionDTO;
import com.moodit.core_service.dto.QuizDetailDTO;
import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.exception.AttemptNotFoundException;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.service.QuizService;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Contrat HTTP de {@link QuizController} hors soumission (couverte par QuizControllerSubmitTest) :
 * passation, édition, historique, révision d'une tentative, mise à jour et suppression.
 */
@WebMvcTest(controllers = QuizController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class QuizControllerTest {

    private static final String EMAIL = "eva@test.ca";

    @Autowired private MockMvc mockMvc;

    @MockitoBean private QuizService quizService;

    private static QuizDetailDTO detail(Boolean isCorrect) {
        return QuizDetailDTO.builder().id(4).title("Récursivité").isPublished(true)
                .questions(List.of(QuestionDTO.builder().id(10).qType("single_choice")
                        .answers(List.of(AnswerDTO.builder().id(1).content("oui").isCorrect(isCorrect).build()))
                        .build()))
                .build();
    }

    @Test
    @DisplayName("GET /quizzes/{id} → 200, passation SANS champ isCorrect dans le JSON")
    void passation_sansCorrection() throws Exception {
        when(quizService.getQuizDetail(4)).thenReturn(detail(null));

        mockMvc.perform(get("/api/quizzes/4"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("Récursivité"))
                .andExpect(jsonPath("$.questions[0].qType").value("single_choice"))
                .andExpect(jsonPath("$.questions[0].answers[0].content").value("oui"))
                .andExpect(jsonPath("$.questions[0].answers[0].isCorrect").doesNotExist())
                .andExpect(jsonPath("$.questions[0].testCases").doesNotExist());
    }

    @Test
    @DisplayName("GET /quizzes/{id} d'un quiz inexistant → 404")
    void passation_inexistant_404() throws Exception {
        when(quizService.getQuizDetail(99)).thenThrow(new QuizNotFoundException());

        mockMvc.perform(get("/api/quizzes/99"))
                .andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("GET /quizzes/{id}/edit → 200 avec la correction")
    void edition_avecCorrection() throws Exception {
        when(quizService.getQuizForEdit(4)).thenReturn(detail(true));

        mockMvc.perform(get("/api/quizzes/4/edit"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.questions[0].answers[0].isCorrect").value(true));
    }

    @Test
    @DisplayName("GET /quizzes/{id}/attempts → historique de l'utilisateur du header")
    void historique() throws Exception {
        when(quizService.getMyAttempts(4, EMAIL)).thenReturn(List.of(
                AttemptSummaryDTO.builder().id(70).attemptNo(1).earned(3.5).max(5.0)
                        .submittedAt(Instant.parse("2026-09-02T08:30:00Z")).build()));

        mockMvc.perform(get("/api/quizzes/4/attempts").header("X-User-Email", EMAIL))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(70))
                .andExpect(jsonPath("$[0].earned").value(3.5))
                .andExpect(jsonPath("$[0].max").value(5.0));
    }

    @Test
    @DisplayName("GET /quizzes/{id}/attempts sans header X-User-Email → 400")
    void historique_sansEmail_400() throws Exception {
        mockMvc.perform(get("/api/quizzes/4/attempts"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(quizService);
    }

    @Test
    @DisplayName("GET /quizzes/{id}/attempts/{attemptId} → résultat corrigé de la tentative")
    void revision() throws Exception {
        when(quizService.getAttemptResult(70, EMAIL)).thenReturn(
                QuizResultDTO.builder().quizId(4).attemptId(70).attemptNo(1).earned(2.0).max(4.0)
                        .questions(List.of()).build());

        mockMvc.perform(get("/api/quizzes/4/attempts/70").header("X-User-Email", EMAIL))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.attemptId").value(70))
                .andExpect(jsonPath("$.earned").value(2.0));
    }

    @Test
    @DisplayName("Révision d'une tentative qui n'appartient pas à l'utilisateur → 404")
    void revision_tentativeDunAutre_404() throws Exception {
        when(quizService.getAttemptResult(71, EMAIL)).thenThrow(new AttemptNotFoundException());

        mockMvc.perform(get("/api/quizzes/4/attempts/71").header("X-User-Email", EMAIL))
                .andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("PUT /quizzes/{id} → 200 avec le quiz mis à jour, corps transmis au service")
    void miseAJour() throws Exception {
        when(quizService.updateQuiz(eq(4), any(QuizDetailDTO.class))).thenReturn(detail(true));

        mockMvc.perform(put("/api/quizzes/4")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"Récursivité\",\"allowRetry\":true,\"questions\":[]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(4));

        verify(quizService).updateQuiz(eq(4),
                argThat(dto -> "Récursivité".equals(dto.getTitle()) && Boolean.TRUE.equals(dto.getAllowRetry())));
    }

    @Test
    @DisplayName("DELETE /quizzes/{id} → 204")
    void suppression_204() throws Exception {
        mockMvc.perform(delete("/api/quizzes/4"))
                .andExpect(status().isNoContent());

        verify(quizService).deleteQuiz(4);
    }

    @Test
    @DisplayName("DELETE d'un quiz inexistant → 404")
    void suppression_inexistant_404() throws Exception {
        doThrow(new QuizNotFoundException()).when(quizService).deleteQuiz(99);

        mockMvc.perform(delete("/api/quizzes/99"))
                .andExpect(status().isNotFound());
    }
}
