package com.moodit.core_service.controller;

import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.LanguageDTO;
import com.moodit.core_service.dto.QuestionTypeDTO;
import com.moodit.core_service.service.QuizService;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Catalogues de l'éditeur de quiz : {@link QuestionTypeController} (/api/question-types) et
 * {@link LanguageController} (/api/languages), qui délèguent à {@link QuizService}.
 */
@WebMvcTest(controllers = {QuestionTypeController.class, LanguageController.class},
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class QuizCatalogControllerTest {

    @Autowired private MockMvc mockMvc;

    @MockitoBean private QuizService quizService;

    @Test
    @DisplayName("GET /question-types → 200 avec id, slug et libellé")
    void typesDeQuestion() throws Exception {
        when(quizService.getQuestionTypes()).thenReturn(List.of(
                new QuestionTypeDTO(1, "true_false", "Vrai/Faux"),
                new QuestionTypeDTO(6, "coding", "Code")));

        mockMvc.perform(get("/api/question-types"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[1].id").value(6))
                .andExpect(jsonPath("$[1].slug").value("coding"))
                .andExpect(jsonPath("$[1].label").value("Code"));

        verify(quizService).getQuestionTypes();
        verifyNoMoreInteractions(quizService);
    }

    @Test
    @DisplayName("GET /question-types sans type en base → 200 et liste vide (pas 404)")
    void typesDeQuestion_vide() throws Exception {
        when(quizService.getQuestionTypes()).thenReturn(List.of());

        mockMvc.perform(get("/api/question-types"))
                .andExpect(status().isOk())
                .andExpect(content().json("[]"));
    }

    @Test
    @DisplayName("Catalogues en lecture seule : POST → 405, service non appelé")
    void catalogues_lectureSeule_405() throws Exception {
        mockMvc.perform(post("/api/question-types")).andExpect(status().isMethodNotAllowed());
        mockMvc.perform(post("/api/languages")).andExpect(status().isMethodNotAllowed());

        verifyNoInteractions(quizService);
    }

    @Test
    @DisplayName("GET /languages → 200 avec les templates de l'éditeur")
    void langages() throws Exception {
        when(quizService.getLanguages()).thenReturn(List.of(
                LanguageDTO.builder().id(2).name("python").harnessTemplate("h").startCodeTemplate("s").build()));

        mockMvc.perform(get("/api/languages"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].name").value("python"))
                .andExpect(jsonPath("$[0].harnessTemplate").value("h"))
                .andExpect(jsonPath("$[0].startCodeTemplate").value("s"))
                .andExpect(jsonPath("$[0].harnessLanguageId").doesNotExist());

        verify(quizService).getLanguages();
        verifyNoMoreInteractions(quizService);
    }
}
