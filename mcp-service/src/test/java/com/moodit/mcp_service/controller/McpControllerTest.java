package com.moodit.mcp_service.controller;

import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.mcp_service.dto.Author;
import com.moodit.mcp_service.dto.McpResponseDto;
import com.moodit.mcp_service.dto.McpResponseSummaryDto;
import com.moodit.mcp_service.exception.AnalysisAlreadyRunningException;
import com.moodit.mcp_service.exception.AnalysisNotFoundException;
import com.moodit.mcp_service.exception.CourseNotFoundException;
import com.moodit.mcp_service.exception.ForbiddenException;
import com.moodit.mcp_service.exception.GlobalExceptionHandler;
import com.moodit.mcp_service.exception.UserNotFoundException;
import com.moodit.mcp_service.service.McpService;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * Contrat HTTP de /mcp : 202 sans corps au déclenchement (résultat par WS), 409 si une analyse
 * est déjà en cours (verrou cours/utilisateur), 404 sur ressource absente, et transmission de
 * l'identité {@code X-User-Email} au service. MockMvc autonome (pas de contexte Spring ni de BD) ;
 * l'autorisation par rôle est hors périmètre (permission-service).
 */
@ExtendWith(MockitoExtension.class)
class McpControllerTest {

    @Mock private McpService mcpService;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.standaloneSetup(new McpController(mcpService))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @Test
    void requestAnalysis_repond202SansCorps_etTransmetLEmail() throws Exception {
        mvc.perform(post("/mcp/courses/10/analyses").header("X-User-Email", "prof@usherbrooke.ca"))
                .andExpect(status().isAccepted())
                .andExpect(content().string(""));

        verify(mcpService).requestAnalysis(10, "prof@usherbrooke.ca");
    }

    @Test
    void requestAnalysis_dejaEnCours_repond409AvecLeMotif() throws Exception {
        doThrow(new AnalysisAlreadyRunningException()).when(mcpService).requestAnalysis(10, "a@a");

        mvc.perform(post("/mcp/courses/10/analyses").header("X-User-Email", "a@a"))
                .andExpect(status().isConflict())
                .andExpect(content().string("Une analyse est déjà en cours pour ce cours"));
    }

    @Test
    void requestAnalysis_coursInconnu_repond404() throws Exception {
        doThrow(new CourseNotFoundException()).when(mcpService).requestAnalysis(99, "a@a");

        mvc.perform(post("/mcp/courses/99/analyses").header("X-User-Email", "a@a"))
                .andExpect(status().isNotFound())
                .andExpect(content().string("Cours introuvable"));
    }

    @Test
    void requestAnalysis_sansEnTeteDIdentite_estRefuse_sansAppelerLeService() throws Exception {
        mvc.perform(post("/mcp/courses/10/analyses"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(mcpService);
    }

    @Test
    void isPending_renvoieLeBooleenDuService() throws Exception {
        when(mcpService.isPending(10, "a@a")).thenReturn(true);

        mvc.perform(get("/mcp/courses/10/pending").header("X-User-Email", "a@a"))
                .andExpect(status().isOk())
                .andExpect(content().string("true"));
    }

    @Test
    void isPending_utilisateurInconnu_repond404() throws Exception {
        when(mcpService.isPending(10, "x@x")).thenThrow(new UserNotFoundException());

        mvc.perform(get("/mcp/courses/10/pending").header("X-User-Email", "x@x"))
                .andExpect(status().isNotFound())
                .andExpect(content().string("Utilisateur introuvable"));
    }

    @Test
    void listAnalyses_renvoieLesResumesEnJson() throws Exception {
        when(mcpService.listAnalyses(10)).thenReturn(List.of(
                new McpResponseSummaryDto(2, "2026-01-02T12:00:00Z", 3, 1)));

        mvc.perform(get("/mcp/courses/10/analyses"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(2))
                .andExpect(jsonPath("$[0].createdAt").value("2026-01-02T12:00:00Z"))
                .andExpect(jsonPath("$[0].strengthsCount").value(3))
                .andExpect(jsonPath("$[0].improvementsCount").value(1));
    }

    @Test
    void getAnalysis_renvoieLeDetail() throws Exception {
        when(mcpService.getAnalysis(42)).thenReturn(new McpResponseDto(
                42, "2026-07-02T16:21:38Z", "{}", 5, 10,
                new Author(5, "jdoe", "Jean", "Doe", "#123456")));

        mvc.perform(get("/mcp/analyses/42"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(42))
                .andExpect(jsonPath("$.courseId").value(10))
                .andExpect(jsonPath("$.author.username").value("jdoe"));
    }

    @Test
    void getAnalysis_absente_repond404() throws Exception {
        when(mcpService.getAnalysis(999)).thenThrow(new AnalysisNotFoundException());

        mvc.perform(get("/mcp/analyses/999"))
                .andExpect(status().isNotFound())
                .andExpect(content().string("Analyse introuvable"));
    }

    @Test
    void forbidden_estTraduitEn403() throws Exception {
        when(mcpService.getAnalysis(1)).thenThrow(new ForbiddenException());

        mvc.perform(get("/mcp/analyses/1"))
                .andExpect(status().isForbidden())
                .andExpect(content().string("Accès refusé"));
    }
}
