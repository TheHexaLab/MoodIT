package com.moodit.mcp_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.mcp_service.exception.AnalysisAlreadyRunningException;
import com.moodit.mcp_service.exception.AnalysisNotFoundException;
import com.moodit.mcp_service.exception.ForbiddenException;
import com.moodit.mcp_service.exception.UserNotFoundException;
import com.moodit.mcp_service.model.Course;
import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;
import com.moodit.mcp_service.model.Role;
import com.moodit.mcp_service.model.User;
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
 * Autorisation (rôle admin) et garde de concurrence (une analyse en cours par cours/user).
 * Repositories mockés — on vérifie les exceptions métier et le déclenchement du job.
 */
@ExtendWith(MockitoExtension.class)
class McpServiceTest {

    @Mock private McpResponseRepository mcpResponseRepository;
    @Mock private CourseRepository courseRepository;
    @Mock private UserRepository userRepository;
    @Mock private McpAnalysisRunner analysisRunner;

    private McpService service;

    @BeforeEach
    void setUp() {
        service = new McpService(
                mcpResponseRepository, courseRepository, userRepository,
                new ObjectMapper(), analysisRunner);
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
    void listAnalyses_nonAdmin_isForbidden() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Etudiant")));

        assertThatThrownBy(() -> service.listAnalyses(10, "a@a"))
                .isInstanceOf(ForbiddenException.class);
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
        // L'analyse est cherchée AVANT l'autorisation (elle donne le courseId à contrôler) :
        // une analyse absente → 404 sans même résoudre l'utilisateur.
        when(mcpResponseRepository.findById(999)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getAnalysis(999, "a@a"))
                .isInstanceOf(AnalysisNotFoundException.class);
    }

    @Test
    void listAnalyses_globalGardien_isAllowed() {
        // Rôle GLOBAL Gardien (User_Role) → accès à N'IMPORTE quel cours.
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Gardien")));
        when(mcpResponseRepository.findByCourse_IdAndStatusOrderByCreatedAtDesc(10, McpStatus.DONE))
                .thenReturn(List.of());

        assertThat(service.listAnalyses(10, "a@a")).isEmpty();
    }

    @Test
    void listAnalyses_programTeacher_isAllowed() {
        // Aucun rôle GLOBAL admin, mais Enseignant (User_Program_Role) d'un programme du cours.
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Etudiant")));
        when(userRepository.hasProgramTeachingRoleForCourse(5, 10)).thenReturn(true);
        when(mcpResponseRepository.findByCourse_IdAndStatusOrderByCreatedAtDesc(10, McpStatus.DONE))
                .thenReturn(List.of());

        assertThat(service.listAnalyses(10, "a@a")).isEmpty();
    }
}
