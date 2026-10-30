package com.moodit.mcp_service.service.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.mcp_service.model.Course;
import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;
import com.moodit.mcp_service.model.User;
import com.moodit.mcp_service.repository.McpResponseRepository;
import java.lang.reflect.Method;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.annotation.Transactional;

/**
 * Tâche planifiée : une analyse PENDING depuis plus de N minutes passe en FAILED et son lanceur
 * reçoit l'évènement d'échec (popup débloquée). La date limite est calculée en UTC.
 */
@ExtendWith(MockitoExtension.class)
class StalePendingAnalysisJobTest {

    @Mock private McpResponseRepository mcpResponseRepository;
    @Mock private McpRealtimeGateway realtimeGateway;

    /** 12:00 UTC (created_at est écrit en UTC par la base). */
    private static final Instant NOW = Instant.parse("2026-10-30T12:00:00Z");

    private StalePendingAnalysisJob job(long minutes) {
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        return new StalePendingAnalysisJob(mcpResponseRepository, realtimeGateway, clock, minutes);
    }

    private static McpResponse pending(int id, int courseId, int userId) {
        Course course = new Course();
        course.setId(courseId);
        User user = new User();
        user.setId(userId);
        McpResponse r = new McpResponse();
        r.setId(id);
        r.setCourse(course);
        r.setUser(user);
        r.setStatus(McpStatus.PENDING);
        return r;
    }

    @Test
    void lesPendingTropAnciennes_passentEnFailed_etLeLanceurEstNotifie() {
        McpResponse a = pending(1, 10, 5);
        McpResponse b = pending(2, 11, 6);
        LocalDateTime cutoff = LocalDateTime.of(2026, 10, 30, 11, 45);
        when(mcpResponseRepository.findByStatusAndCreatedAtBefore(McpStatus.PENDING, cutoff))
                .thenReturn(List.of(a, b));

        job(15).failStalePending();

        assertThat(a.getStatus()).isEqualTo(McpStatus.FAILED);
        assertThat(b.getStatus()).isEqualTo(McpStatus.FAILED);
        verify(mcpResponseRepository).saveAll(List.of(a, b));
        verify(realtimeGateway).analysisFailed(10L, 5L, McpAnalysisRunner.UNAVAILABLE);
        verify(realtimeGateway).analysisFailed(11L, 6L, McpAnalysisRunner.UNAVAILABLE);
    }

    @Test
    void aucunePendingBloquee_rienNestEcritNiPousse() {
        when(mcpResponseRepository.findByStatusAndCreatedAtBefore(
                        McpStatus.PENDING, LocalDateTime.of(2026, 10, 30, 11, 50)))
                .thenReturn(List.of());

        job(10).failStalePending();

        verify(mcpResponseRepository, never()).saveAll(any());
        verifyNoInteractions(realtimeGateway);
    }

    @Test
    void constructeurSpring_utiliseLHorlogeUtc() {
        StalePendingAnalysisJob job = new StalePendingAnalysisJob(mcpResponseRepository, realtimeGateway, 10);
        when(mcpResponseRepository.findByStatusAndCreatedAtBefore(any(), any())).thenReturn(List.of());
        LocalDateTime before = LocalDateTime.now(ZoneOffset.UTC).minusMinutes(10);

        job.failStalePending();

        org.mockito.ArgumentCaptor<LocalDateTime> cutoff = org.mockito.ArgumentCaptor.forClass(LocalDateTime.class);
        verify(mcpResponseRepository).findByStatusAndCreatedAtBefore(any(), cutoff.capture());
        assertThat(cutoff.getValue()).isBetween(before, LocalDateTime.now(ZoneOffset.UTC).minusMinutes(10));
    }

    @Test
    void laMethodeEstPlanifieeEtTransactionnelle() throws Exception {
        Method m = StalePendingAnalysisJob.class.getMethod("failStalePending");
        Scheduled scheduled = m.getAnnotation(Scheduled.class);
        assertThat(scheduled).isNotNull();
        assertThat(scheduled.fixedDelayString()).isEqualTo("${app.mcp.pending-check-interval-ms:60000}");
        assertThat(m.getAnnotation(Transactional.class)).isNotNull();
    }
}
