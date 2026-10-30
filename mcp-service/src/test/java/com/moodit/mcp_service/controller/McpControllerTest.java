package com.moodit.mcp_service.controller;

import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
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
import org.springframework.http.MediaType;
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
    void listAnalyses_repond200_etInterrogeLeServicePourLeCoursDuChemin() throws Exception {
        when(mcpService.listAnalyses(10)).thenReturn(List.of(
                new McpResponseSummaryDto(2, "2026-01-02T12:00:00Z", 3, 1)));

        // L'en-tête d'identité n'entre pas en jeu : l'historique est celui du COURS, pas de l'utilisateur.
        mvc.perform(get("/mcp/courses/10/analyses").header("X-User-Email", "a@a"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(2))
                .andExpect(jsonPath("$[0].createdAt").value("2026-01-02T12:00:00Z"))
                .andExpect(jsonPath("$[0].strengthsCount").value(3))
                .andExpect(jsonPath("$[0].improvementsCount").value(1));

        verify(mcpService).listAnalyses(10);
        verifyNoMoreInteractions(mcpService);
    }

    @Test
    void listAnalyses_sansAnalyse_repond200AvecUneListeVide() throws Exception {
        when(mcpService.listAnalyses(7)).thenReturn(List.of());

        mvc.perform(get("/mcp/courses/7/analyses"))
                .andExpect(status().isOk())
                .andExpect(content().json("[]"));

        verify(mcpService).listAnalyses(7);
    }

    @Test
    void listAnalyses_idDeCoursNonNumerique_repond400_sansAppelerLeService() throws Exception {
        mvc.perform(get("/mcp/courses/abc/analyses"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(mcpService);
    }

    @Test
    void listAnalyses_coursInconnu_repond404_etAccesRefuse_repond403() throws Exception {
        when(mcpService.listAnalyses(99)).thenThrow(new CourseNotFoundException());
        when(mcpService.listAnalyses(3)).thenThrow(new ForbiddenException());

        mvc.perform(get("/mcp/courses/99/analyses"))
                .andExpect(status().isNotFound())
                .andExpect(content().string("Cours introuvable"));
        mvc.perform(get("/mcp/courses/3/analyses"))
                .andExpect(status().isForbidden())
                .andExpect(content().string("Accès refusé"));
    }

    @Test
    void getAnalysis_repond200_avecLeDetailComplet_pourLIdDuChemin() throws Exception {
        when(mcpService.getAnalysis(42)).thenReturn(new McpResponseDto(
                42, "2026-07-02T16:21:38Z", "{\"summary\":\"ok\"}", 5, 10,
                new Author(5, "jdoe", "Jean", "Doe", "#123456"), "LLM"));

        mvc.perform(get("/mcp/analyses/42").header("X-User-Email", "a@a"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.id").value(42))
                .andExpect(jsonPath("$.createdAt").value("2026-07-02T16:21:38Z"))
                .andExpect(jsonPath("$.content").value("{\"summary\":\"ok\"}"))
                .andExpect(jsonPath("$.userId").value(5))
                .andExpect(jsonPath("$.courseId").value(10))
                .andExpect(jsonPath("$.author.id").value(5))
                .andExpect(jsonPath("$.author.username").value("jdoe"))
                .andExpect(jsonPath("$.source").value("LLM"));

        verify(mcpService).getAnalysis(42);
        verifyNoMoreInteractions(mcpService);
    }

    @Test
    void getAnalysis_absente_repond404() throws Exception {
        when(mcpService.getAnalysis(999)).thenThrow(new AnalysisNotFoundException());

        mvc.perform(get("/mcp/analyses/999"))
                .andExpect(status().isNotFound())
                .andExpect(content().string("Analyse introuvable"));
    }

    @Test
    void getAnalysis_idNonNumerique_repond400_sansAppelerLeService() throws Exception {
        mvc.perform(get("/mcp/analyses/abc"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(mcpService);
    }

    @Test
    void forbidden_estTraduitEn403() throws Exception {
        when(mcpService.getAnalysis(1)).thenThrow(new ForbiddenException());

        mvc.perform(get("/mcp/analyses/1"))
                .andExpect(status().isForbidden())
                .andExpect(content().string("Accès refusé"));
    }
}
