package com.moodit.mcp_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.mcp_service.exception.AnalysisAlreadyRunningException;
import com.moodit.mcp_service.exception.AnalysisNotFoundException;
import com.moodit.mcp_service.exception.UserNotFoundException;
import com.moodit.mcp_service.model.Course;
import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;
import com.moodit.mcp_service.model.Role;
import com.moodit.mcp_service.model.User;
import com.moodit.mcp_service.repository.AuditLogRepository;
import com.moodit.mcp_service.repository.CourseRepository;
import com.moodit.mcp_service.repository.McpResponseRepository;
import com.moodit.mcp_service.repository.UserRepository;
import com.moodit.mcp_service.service.mcp.McpAnalysisRunner;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import tools.jackson.databind.ObjectMapper;

/**
 * Logique MÉTIER du feedback MCP (garde de concurrence : une analyse en cours par cours/user,
 * 404 analyse absente, déclenchement du job). L'AUTORISATION PAR RÔLE n'est plus ici : elle est
 * déléguée au permission-service (règles /mcp/**) — d'où l'absence de test de 403.
 * Repositories mockés.
 */
@ExtendWith(MockitoExtension.class)
class McpServiceTest {

    @Mock private McpResponseRepository mcpResponseRepository;
    @Mock private CourseRepository courseRepository;
    @Mock private UserRepository userRepository;
    @Mock private McpAnalysisRunner analysisRunner;
    @Mock private AuditLogRepository auditLogRepository;

    private McpService service;

    @BeforeEach
    void setUp() {
        service = new McpService(
                mcpResponseRepository, courseRepository, userRepository,
                new ObjectMapper(), analysisRunner, auditLogRepository);
    }

    private static User user(int id, String roleName) {
        User u = new User();
        u.setId(id);
        u.setEmail("a@a");
        Role r = new Role();
        r.setName(roleName);
        u.setRoles(List.of(r));
        return u;
    }

    @Test
    void requestAnalysis_unknownUser_throwsUserNotFound() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.requestAnalysis(10, "a@a"))
                .isInstanceOf(UserNotFoundException.class);
    }

    @Test
    void requestAnalysis_happyPath_savesPendingAndRunsJob() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Administrateur")));
        Course course = new Course();
        course.setId(10);
        when(courseRepository.findById(10)).thenReturn(Optional.of(course));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(false);
        McpResponse saved = new McpResponse();
        saved.setId(42);
        when(mcpResponseRepository.saveAndFlush(any(McpResponse.class))).thenReturn(saved);

        service.requestAnalysis(10, "a@a");

        // Hors transaction (test unitaire) : afterCommit s'exécute immédiatement.
        verify(analysisRunner).run(42);
    }

    @Test
    void requestAnalysis_alreadyPending_throws409_andDoesNotRun() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Administrateur")));
        Course course = new Course();
        course.setId(10);
        when(courseRepository.findById(10)).thenReturn(Optional.of(course));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(true);

        assertThatThrownBy(() -> service.requestAnalysis(10, "a@a"))
                .isInstanceOf(AnalysisAlreadyRunningException.class);

        verify(mcpResponseRepository, never()).saveAndFlush(any());
        verify(analysisRunner, never()).run(any());
    }

    @Test
    void requestAnalysis_concurrentInsert_mapsUniqueViolationTo409() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Administrateur")));
        Course course = new Course();
        course.setId(10);
        when(courseRepository.findById(10)).thenReturn(Optional.of(course));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(false);
        when(mcpResponseRepository.saveAndFlush(any(McpResponse.class)))
                .thenThrow(new DataIntegrityViolationException("uq_mcp_response_pending"));

        assertThatThrownBy(() -> service.requestAnalysis(10, "a@a"))
                .isInstanceOf(AnalysisAlreadyRunningException.class);

        verify(analysisRunner, never()).run(any());
    }

    @Test
    void isPending_returnsRepositoryValue() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Administrateur")));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(true);

        assertThat(service.isPending(10, "a@a")).isTrue();
    }

    @Test
    void getAnalysis_missing_throwsNotFound() {
        // Analyse absente → 404 (l'autorisation par rôle est faite en amont par le gateway).
        when(mcpResponseRepository.findById(999)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getAnalysis(999))
                .isInstanceOf(AnalysisNotFoundException.class);
    }

    @Test
    void listAnalyses_returnsSummaries() {
        // L'autorisation n'est plus dans le service : listAnalyses se contente de projeter.
        when(mcpResponseRepository.findByCourse_IdAndStatusOrderByCreatedAtDesc(10, McpStatus.DONE))
                .thenReturn(List.of());

        assertThat(service.listAnalyses(10)).isEmpty();
    }
}
