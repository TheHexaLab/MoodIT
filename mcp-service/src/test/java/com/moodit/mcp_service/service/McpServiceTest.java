package com.moodit.mcp_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.tuple;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.mcp_service.exception.AnalysisAlreadyRunningException;
import com.moodit.mcp_service.dto.McpResponseDto;
import com.moodit.mcp_service.dto.McpResponseSummaryDto;
import com.moodit.mcp_service.exception.AnalysisNotFoundException;
import com.moodit.mcp_service.exception.CourseNotFoundException;
import com.moodit.mcp_service.model.AuditLog;
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
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
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
    void requestAnalysis_fileDAnalysePleine_marqueLAnalyseRefusee() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Administrateur")));
        Course course = new Course();
        course.setId(10);
        when(courseRepository.findById(10)).thenReturn(Optional.of(course));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(false);
        McpResponse saved = new McpResponse();
        saved.setId(42);
        when(mcpResponseRepository.saveAndFlush(any(McpResponse.class))).thenReturn(saved);
        org.mockito.Mockito.doThrow(new org.springframework.core.task.TaskRejectedException("pleine"))
                .when(analysisRunner).run(42);

        service.requestAnalysis(10, "a@a");

        // Le refus ne remonte pas au client (la ligne existe déjà) : l'analyse passe en FAILED.
        verify(analysisRunner).markRejected(42);
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

    // ── Compléments (#90) ────────────────────────────────────────────────────

    private static Course course(int id, String title, String code) {
        Course c = new Course();
        c.setId(id);
        c.setTitle(title);
        c.setCode(code);
        return c;
    }

    /** Stubs communs d'une demande d'analyse acceptée (user 5, cours 10, aucune en cours). */
    private void stubAcceptedRequest(Course course, int savedId) {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Enseignant")));
        when(courseRepository.findById(10)).thenReturn(Optional.of(course));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(false);
        McpResponse saved = new McpResponse();
        saved.setId(savedId);
        when(mcpResponseRepository.saveAndFlush(any(McpResponse.class))).thenReturn(saved);
    }

    @Test
    void requestAnalysis_creeUneLignePendingPourLeCoursEtLUtilisateur() {
        Course course = course(10, "Algo", "IFT101");
        stubAcceptedRequest(course, 42);

        service.requestAnalysis(10, "a@a");

        ArgumentCaptor<McpResponse> captor = ArgumentCaptor.forClass(McpResponse.class);
        verify(mcpResponseRepository).saveAndFlush(captor.capture());
        McpResponse pending = captor.getValue();
        assertThat(pending.getStatus()).isEqualTo(McpStatus.PENDING);
        assertThat(pending.getCourse()).isSameAs(course);
        assertThat(pending.getUser().getId()).isEqualTo(5);
        assertThat(pending.getContent()).as("pas de contenu tant que PENDING").isNull();
    }

    @Test
    void requestAnalysis_journaliseLaDemandeDansLAudit() {
        stubAcceptedRequest(course(10, "Algo", "IFT101"), 42);

        service.requestAnalysis(10, "a@a");

        ArgumentCaptor<AuditLog> captor = ArgumentCaptor.forClass(AuditLog.class);
        verify(auditLogRepository).save(captor.capture());
        AuditLog audit = captor.getValue();
        assertThat(audit.getActorEmail()).isEqualTo("a@a");
        assertThat(audit.getAction()).isEqualTo("MCP_ANALYSIS_REQUEST");
        assertThat(audit.getEntityType()).isEqualTo("MCP");
        assertThat(audit.getEntityId()).isEqualTo(10);
        assertThat(audit.getSummary()).isEqualTo("Analyse MCP demandée pour le cours « Algo » (IFT101)");
        assertThat(audit.getDetails()).isEqualTo("Cours : Algo (IFT101)");
    }

    @Test
    void requestAnalysis_verrouOccupe_nEcritPasDAudit() {
        // 409 (verrou cours/user) : aucune trace d'audit pour une demande refusée.
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Enseignant")));
        when(courseRepository.findById(10)).thenReturn(Optional.of(course(10, "Algo", "IFT101")));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(true);

        assertThatThrownBy(() -> service.requestAnalysis(10, "a@a"))
                .isInstanceOf(AnalysisAlreadyRunningException.class)
                .hasMessage("Une analyse est déjà en cours pour ce cours");

        verify(auditLogRepository, never()).save(any());
    }

    @Test
    void requestAnalysis_verrouParUtilisateur_unAutreUtilisateurPeutLancerSurLeMemeCours() {
        // Le verrou porte sur (cours, utilisateur) : la recherche se fait avec l'id du DEMANDEUR.
        when(userRepository.findByEmail("b@b")).thenReturn(Optional.of(user(6, "Enseignant")));
        when(courseRepository.findById(10)).thenReturn(Optional.of(course(10, "Algo", "IFT101")));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 6, McpStatus.PENDING))
                .thenReturn(false);
        McpResponse saved = new McpResponse();
        saved.setId(43);
        when(mcpResponseRepository.saveAndFlush(any(McpResponse.class))).thenReturn(saved);

        service.requestAnalysis(10, "b@b");

        verify(mcpResponseRepository).existsByCourse_IdAndUser_IdAndStatus(10, 6, McpStatus.PENDING);
        verify(analysisRunner).run(43);
    }

    @Test
    void requestAnalysis_violationUnique_nEcritPasDAudit() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Enseignant")));
        when(courseRepository.findById(10)).thenReturn(Optional.of(course(10, "Algo", "IFT101")));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(false);
        when(mcpResponseRepository.saveAndFlush(any(McpResponse.class)))
                .thenThrow(new DataIntegrityViolationException("uq_mcp_response_pending"));

        assertThatThrownBy(() -> service.requestAnalysis(10, "a@a"))
                .isInstanceOf(AnalysisAlreadyRunningException.class);

        verify(auditLogRepository, never()).save(any());
    }

    @Test
    void requestAnalysis_coursInconnu_lanceCourseNotFound_sansRienEcrire() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Enseignant")));
        when(courseRepository.findById(10)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.requestAnalysis(10, "a@a"))
                .isInstanceOf(CourseNotFoundException.class);

        verify(mcpResponseRepository, never()).saveAndFlush(any());
        verify(auditLogRepository, never()).save(any());
        verify(analysisRunner, never()).run(any());
    }

    @Test
    void requestAnalysis_dansUneTransaction_lanceLeJobSeulementApresCommit() {
        // Le thread async doit voir la ligne pending : le job ne part qu'APRÈS le commit.
        stubAcceptedRequest(course(10, "Algo", "IFT101"), 42);
        TransactionSynchronizationManager.initSynchronization();
        try {
            service.requestAnalysis(10, "a@a");

            verify(analysisRunner, never()).run(any());
            List<TransactionSynchronization> syncs =
                    TransactionSynchronizationManager.getSynchronizations();
            assertThat(syncs).hasSize(1);

            syncs.getFirst().afterCommit();

            verify(analysisRunner).run(42);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    void isPending_utilisateurInconnu_lanceUserNotFound() {
        when(userRepository.findByEmail("x@x")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.isPending(10, "x@x"))
                .isInstanceOf(UserNotFoundException.class);
    }

    @Test
    void isPending_faux_quandAucuneAnalyseEnCoursPourCetUtilisateur() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(user(5, "Enseignant")));
        when(mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(10, 5, McpStatus.PENDING))
                .thenReturn(false);

        assertThat(service.isPending(10, "a@a")).isFalse();
    }

    @Test
    void getAnalysis_projetteLeContenuLAuteurEtLHorodatageUtc() {
        User author = user(5, "Enseignant");
        author.setUsername("jdoe");
        author.setFirstName("Jean");
        author.setLastName("Doe");
        author.setAvatarColor("#123456");
        McpResponse r = new McpResponse();
        r.setId(42);
        r.setCreatedAt(LocalDateTime.of(2026, 7, 2, 16, 21, 38));
        r.setContent("{\"score\":80}");
        r.setStatus(McpStatus.DONE);
        r.setUser(author);
        r.setCourse(course(10, "Algo", "IFT101"));
        when(mcpResponseRepository.findById(42)).thenReturn(Optional.of(r));

        McpResponseDto dto = service.getAnalysis(42);

        assertThat(dto.id()).isEqualTo(42);
        assertThat(dto.createdAt()).isEqualTo("2026-07-02T16:21:38Z");
        assertThat(dto.content()).isEqualTo("{\"score\":80}");
        assertThat(dto.userId()).isEqualTo(5);
        assertThat(dto.courseId()).isEqualTo(10);
        assertThat(dto.author().id()).isEqualTo(5);
        assertThat(dto.author().username()).isEqualTo("jdoe");
        assertThat(dto.author().firstName()).isEqualTo("Jean");
        assertThat(dto.author().lastName()).isEqualTo("Doe");
        assertThat(dto.author().avatarColor()).isEqualTo("#123456");
    }

    private static McpResponse done(int id, String content) {
        McpResponse r = new McpResponse();
        r.setId(id);
        r.setCreatedAt(LocalDateTime.of(2026, 1, id, 12, 0));
        r.setContent(content);
        r.setStatus(McpStatus.DONE);
        return r;
    }

    @Test
    void listAnalyses_deriveLesCompteursDuContenuJson_dansLOrdreDuDepot() {
        when(mcpResponseRepository.findByCourse_IdAndStatusOrderByCreatedAtDesc(10, McpStatus.DONE))
                .thenReturn(List.of(
                        done(2, "{\"score\":70,\"strengths\":[\"a\",\"b\",\"c\"],"
                                + "\"improvements\":[\"x\"]}"),
                        done(1, "{\"score\":50,\"strengths\":[],\"improvements\":[\"x\",\"y\"]}")));

        List<McpResponseSummaryDto> list = service.listAnalyses(10);

        assertThat(list).containsExactly(
                new McpResponseSummaryDto(2, "2026-01-02T12:00:00Z", 3, 1),
                new McpResponseSummaryDto(1, "2026-01-01T12:00:00Z", 0, 2));
    }

    @Test
    void listAnalyses_contenuAbsentIllisibleOuSansListes_donneDesCompteursAZero() {
        // L'entrée reste listée (pas d'exception) : compteurs à 0.
        when(mcpResponseRepository.findByCourse_IdAndStatusOrderByCreatedAtDesc(10, McpStatus.DONE))
                .thenReturn(List.of(
                        done(1, null),
                        done(2, "   "),
                        done(3, "pas du json"),
                        done(4, "{\"score\":10}")));

        assertThat(service.listAnalyses(10))
                .extracting(McpResponseSummaryDto::id, McpResponseSummaryDto::strengthsCount,
                        McpResponseSummaryDto::improvementsCount)
                .containsExactly(
                        tuple(1L, 0, 0),
                        tuple(2L, 0, 0),
                        tuple(3L, 0, 0),
                        tuple(4L, 0, 0));
    }
}
