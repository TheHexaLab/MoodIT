package com.moodit.mcp_service.service.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.mcp_service.dto.McpAnalysis;
import com.moodit.mcp_service.dto.McpResponseSummaryDto;
import com.moodit.mcp_service.model.Course;
import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;
import com.moodit.mcp_service.model.User;
import com.moodit.mcp_service.repository.CourseStatsRepository;
import com.moodit.mcp_service.repository.McpResponseRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

/**
 * Orchestration du job d'analyse : succès LLM, REPLI déterministe si le LLM échoue (le job
 * n'échoue PAS), et — sur erreur inattendue — statut FAILED avec un motif GÉNÉRIQUE poussé au
 * client (on ne divulgue jamais le message d'exception interne).
 */
@ExtendWith(MockitoExtension.class)
class McpAnalysisRunnerTest {

    @Mock private McpResponseRepository mcpResponseRepository;
    @Mock private CourseStatsRepository courseStatsRepository;
    @Mock private CoreQuizStatsClient coreQuizStatsClient;
    @Mock private McpAnalysisClient analysisClient;
    @Mock private McpRealtimeGateway realtimeGateway;

    private McpAnalysisRunner runner;

    @BeforeEach
    void setUp() {
        runner = new McpAnalysisRunner(
                mcpResponseRepository, courseStatsRepository, coreQuizStatsClient,
                analysisClient, realtimeGateway, new ObjectMapper());
    }

    private McpResponse pending() {
        Course course = new Course();
        course.setId(10);
        User user = new User();
        user.setId(5);
        McpResponse r = new McpResponse();
        r.setId(1);
        r.setCourse(course);
        r.setUser(user);
        r.setStatus(McpStatus.PENDING);
        return r;
    }

    /** Stubs des compteurs de contexte (utilisés quand la collecte va au bout). */
    private void stubStats() {
        when(courseStatsRepository.countQuizzes(10)).thenReturn(6);
        when(courseStatsRepository.countForumMessages(10)).thenReturn(9);
        when(courseStatsRepository.countStudents(10)).thenReturn(3);
        when(courseStatsRepository.sampleForumMessages(10, 20)).thenReturn(List.of("ok"));
        when(courseStatsRepository.countQuizAttempts(10)).thenReturn(3);
        when(courseStatsRepository.countDistinctQuizStudents(10)).thenReturn(3);
        when(courseStatsRepository.codeTestPassRate(10)).thenReturn(null);
        when(coreQuizStatsClient.averageScorePercent(10)).thenReturn(67);
    }

    private static McpAnalysis analysis() {
        return new McpAnalysis(
                80, "résumé",
                new McpAnalysis.Dimensions(90, 80, 70, 60),
                List.of("f1", "f2"), List.of("i1"), List.of("r1"),
                new McpAnalysis.Sources(0, 0, 0));
    }

    @Test
    void success_marksDone_andPushesCreatedEvent() {
        McpResponse response = pending();
        when(mcpResponseRepository.findById(1)).thenReturn(Optional.of(response));
        stubStats();
        when(analysisClient.analyze(any())).thenReturn(analysis());

        runner.run(1);

        assertThat(response.getStatus()).isEqualTo(McpStatus.DONE);
        assertThat(response.getContent()).contains("\"score\":80");
        verify(mcpResponseRepository).save(response);
        verify(realtimeGateway).analysisCreated(eq(10L), any(McpResponseSummaryDto.class));
        verify(realtimeGateway, never()).analysisFailed(anyLong(), anyLong(), any());
    }

    @Test
    void llmFailure_fallsBackToDeterministic_withoutFailingTheJob() {
        McpResponse response = pending();
        when(mcpResponseRepository.findById(1)).thenReturn(Optional.of(response));
        stubStats();
        when(analysisClient.analyze(any()))
                .thenThrow(new McpAnalysisException("LLM indisponible"));

        runner.run(1);

        // Le repli déterministe produit quand même une analyse : statut DONE, event created.
        assertThat(response.getStatus()).isEqualTo(McpStatus.DONE);
        verify(realtimeGateway).analysisProgress(10L, 5L, "fallback");
        verify(realtimeGateway).analysisCreated(eq(10L), any(McpResponseSummaryDto.class));
        verify(realtimeGateway, never()).analysisFailed(anyLong(), anyLong(), any());
    }

    @Test
    void unexpectedError_marksFailed_andPushesGenericReason() {
        McpResponse response = pending();
        when(mcpResponseRepository.findById(1)).thenReturn(Optional.of(response));
        // Erreur inattendue pendant la collecte (ex. base) — PAS une McpAnalysisException.
        when(courseStatsRepository.countQuizzes(10))
                .thenThrow(new RuntimeException("détail SQL interne sensible"));

        runner.run(1);

        assertThat(response.getStatus()).isEqualTo(McpStatus.FAILED);
        // Motif générique : le message d'exception interne ne doit jamais fuir au client.
        verify(realtimeGateway).analysisFailed(10L, 5L, "Analyse indisponible pour le moment.");
    }

    @Test
    void missingResponse_isNoOp() {
        when(mcpResponseRepository.findById(1)).thenReturn(Optional.empty());

        runner.run(1);

        verifyNoInteractions(realtimeGateway, analysisClient, coreQuizStatsClient);
    }
}
