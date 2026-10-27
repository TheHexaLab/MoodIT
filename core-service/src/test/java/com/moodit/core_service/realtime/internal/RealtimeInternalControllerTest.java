package com.moodit.core_service.realtime.internal;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.internal.InternalTokenValidator;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.McpResponseSummaryDto;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Pont WebSocket INTERNE pour mcp-service ({@code /internal/realtime/mcp/**}) : chaque route relaie
 * vers {@link RealtimeEventPublisher} après contrôle du jeton {@code X-Internal-Token}.
 */
@WebMvcTest(controllers = RealtimeInternalController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
@TestPropertySource(properties = "app.internal.token=jeton-de-test")
@Import(InternalTokenValidator.class)
class RealtimeInternalControllerTest {

    private static final String TOKEN = "jeton-de-test";

    @Autowired private MockMvc mockMvc;

    @MockitoBean private RealtimeEventPublisher publisher;

    @Test
    @DisplayName("analysis-created → 204 et résumé relayé à la room mcp du cours")
    void analyseCreee_relayee() throws Exception {
        mockMvc.perform(post("/internal/realtime/mcp/analysis-created").header("X-Internal-Token", TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"courseId\":8,\"id\":42,\"createdAt\":\"2026-06-22T10:00:00.000Z\","
                                + "\"strengthsCount\":3,\"improvementsCount\":2}"))
                .andExpect(status().isNoContent());

        verify(publisher).mcpAnalysisCreated(8L,
                new McpResponseSummaryDto(42L, "2026-06-22T10:00:00.000Z", 3, 2));
    }

    @Test
    @DisplayName("analysis-failed → 204 et échec relayé avec le lanceur et la raison")
    void analyseEchouee_relayee() throws Exception {
        mockMvc.perform(post("/internal/realtime/mcp/analysis-failed").header("X-Internal-Token", TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"courseId\":8,\"userId\":4,\"reason\":\"LLM indisponible\"}"))
                .andExpect(status().isNoContent());

        verify(publisher).mcpAnalysisFailed(8L, 4L, "LLM indisponible");
    }

    @Test
    @DisplayName("analysis-progress → 204 et étape relayée")
    void progression_relayee() throws Exception {
        mockMvc.perform(post("/internal/realtime/mcp/analysis-progress").header("X-Internal-Token", TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"courseId\":8,\"userId\":4,\"step\":\"collecting\"}"))
                .andExpect(status().isNoContent());

        verify(publisher).mcpAnalysisProgress(8L, 4L, "collecting");
    }

    @Test
    @DisplayName("Jeton absent ou faux → 403 sur les trois routes, rien n'est diffusé")
    void jetonInvalide_403() throws Exception {
        mockMvc.perform(post("/internal/realtime/mcp/analysis-created")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"courseId\":8,\"id\":42,\"createdAt\":\"x\",\"strengthsCount\":0,\"improvementsCount\":0}"))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/internal/realtime/mcp/analysis-failed").header("X-Internal-Token", "faux")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"courseId\":8,\"userId\":4,\"reason\":\"r\"}"))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/internal/realtime/mcp/analysis-progress").header("X-Internal-Token", "faux")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"courseId\":8,\"userId\":4,\"step\":\"s\"}"))
                .andExpect(status().isForbidden());

        verifyNoInteractions(publisher);
    }

    @Test
    @DisplayName("Raison absente → relayée comme null (libellé générique côté front)")
    void raisonAbsente_null() throws Exception {
        mockMvc.perform(post("/internal/realtime/mcp/analysis-failed").header("X-Internal-Token", TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"courseId\":8,\"userId\":4}"))
                .andExpect(status().isNoContent());

        verify(publisher).mcpAnalysisFailed(8L, 4L, null);
        verify(publisher, org.mockito.Mockito.never()).mcpAnalysisProgress(anyLong(), anyLong(), anyString());
    }
}
