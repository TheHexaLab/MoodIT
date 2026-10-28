package com.moodit.core_service.internal;

import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.CourseQuizStatsDTO;
import com.moodit.core_service.service.QuizService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Endpoint INTERNE {@code /internal/quiz-stats} (appelé par mcp-service) : hors préfixe /api,
 * protégé par le jeton partagé {@code X-Internal-Token}. Jeton absent ou faux → 403 sans calcul.
 */
@WebMvcTest(controllers = InternalQuizController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
@TestPropertySource(properties = "app.internal.token=jeton-de-test")
@Import(InternalTokenValidator.class)
class InternalQuizControllerTest {

    @Autowired private MockMvc mockMvc;

    @MockitoBean private QuizService quizService;

    @Test
    @DisplayName("Bon jeton → 200 avec l'agrégat du cours")
    void bonJeton_renvoieLesStats() throws Exception {
        when(quizService.getCourseQuizStats(8)).thenReturn(new CourseQuizStatsDTO(67, 3, 2));

        mockMvc.perform(get("/internal/quiz-stats/course/8").header("X-Internal-Token", "jeton-de-test"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.averageScorePercent").value(67))
                .andExpect(jsonPath("$.gradedAttemptCount").value(3))
                .andExpect(jsonPath("$.studentCount").value(2));
    }

    @Test
    @DisplayName("Jeton absent → 403, aucun calcul")
    void jetonAbsent_403() throws Exception {
        mockMvc.perform(get("/internal/quiz-stats/course/8"))
                .andExpect(status().isForbidden());

        verifyNoInteractions(quizService);
    }

    @Test
    @DisplayName("Mauvais jeton → 403, aucun calcul")
    void mauvaisJeton_403() throws Exception {
        mockMvc.perform(get("/internal/quiz-stats/course/8").header("X-Internal-Token", "jeton-pirate"))
                .andExpect(status().isForbidden());

        verifyNoInteractions(quizService);
    }

    @Test
    @DisplayName("Endpoint interne NON préfixé par /api")
    void pasDePrefixeApi() throws Exception {
        mockMvc.perform(get("/api/internal/quiz-stats/course/8").header("X-Internal-Token", "jeton-de-test"))
                .andExpect(status().isNotFound());

        verifyNoInteractions(quizService);
    }
}
