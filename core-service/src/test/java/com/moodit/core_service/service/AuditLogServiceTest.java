package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.AuditLogDTO;
import com.moodit.core_service.model.AuditLog;
import com.moodit.core_service.repository.AuditLogRepository;
import java.time.LocalDateTime;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

/** Tests unitaires de {@link AuditLogService} : acteur, troncature, normalisation de la recherche. */
@ExtendWith(MockitoExtension.class)
class AuditLogServiceTest {

  @Mock private AuditLogRepository repository;

  @InjectMocks private AuditLogService auditLogService;

  @AfterEach
  void clearSecurityContext() {
    SecurityContextHolder.clearContext();
  }

  private static void authenticateAs(String email) {
    SecurityContextHolder.getContext()
        .setAuthentication(new UsernamePasswordAuthenticationToken(email, null, List.of()));
  }

  private AuditLog savedLog() {
    ArgumentCaptor<AuditLog> captor = ArgumentCaptor.forClass(AuditLog.class);
    verify(repository).save(captor.capture());
    return captor.getValue();
  }

  @Test
  @DisplayName("record enregistre l'action avec l'email de l'acteur lu du SecurityContext")
  void record_avec_acteur() {
    authenticateAs("gardien@usherbrooke.ca");

    auditLogService.record("COURSE_DELETE", "COURSE", 4, "Cours supprimé", "Programmes : GI");

    AuditLog log = savedLog();
    assertThat(log.getActorEmail()).isEqualTo("gardien@usherbrooke.ca");
    assertThat(log.getAction()).isEqualTo("COURSE_DELETE");
    assertThat(log.getEntityType()).isEqualTo("COURSE");
    assertThat(log.getEntityId()).isEqualTo(4);
    assertThat(log.getSummary()).isEqualTo("Cours supprimé");
    assertThat(log.getDetails()).isEqualTo("Programmes : GI");
  }

  @Test
  @DisplayName("record sans authentification ni détails : acteur null, détails null, summary null → \"\"")
  void record_sans_acteur_ni_details() {
    auditLogService.record("X", "Y", null, null);

    AuditLog log = savedLog();
    assertThat(log.getActorEmail()).isNull();
    assertThat(log.getEntityId()).isNull();
    assertThat(log.getSummary()).isEmpty();
    assertThat(log.getDetails()).isNull();
  }

  @Test
  @DisplayName("record tronque summary (512) et details (1024) avec une ellipse ; à la limite, inchangés")
  void record_tronque_aux_tailles_de_colonnes() {
    auditLogService.record("A", "B", 1, "s".repeat(600), "d".repeat(2000));

    AuditLog log = savedLog();
    assertThat(log.getSummary()).hasSize(512).endsWith("s…");
    assertThat(log.getDetails()).hasSize(1024).endsWith("d…");

    org.mockito.Mockito.clearInvocations(repository);
    auditLogService.record("A", "B", 1, "s".repeat(512), "d".repeat(1024));
    AuditLog atLimit = savedLog();
    assertThat(atLimit.getSummary()).isEqualTo("s".repeat(512));
    assertThat(atLimit.getDetails()).isEqualTo("d".repeat(1024));
  }

  @Test
  @DisplayName("currentActor renvoie l'email authentifié, sinon null")
  void currentActor() {
    assertThat(auditLogService.currentActor()).isNull();

    authenticateAs("admin@test.ca");
    assertThat(auditLogService.currentActor()).isEqualTo("admin@test.ca");
  }

  @Test
  @DisplayName("search normalise type (trim) et q (%minuscules%), borne limit à [1, 500] et mappe en DTO UTC")
  void search_normalise_et_mappe() {
    AuditLog log = new AuditLog();
    log.setId(9);
    log.setCreatedAt(LocalDateTime.of(2026, 5, 1, 12, 0));
    log.setActorEmail("a@test.ca");
    log.setAction("FORUM_DELETE");
    log.setEntityType("FORUM");
    log.setEntityId(3);
    log.setSummary("Forum #3 supprimé");
    log.setDetails("Cours : X");
    when(repository.search(eq(50), eq("FORUM"), eq("%réseau%"), eq(500))).thenReturn(List.of(log));

    List<AuditLogDTO> result = auditLogService.search(50, "  FORUM ", "  RÉSEAU ", 10_000);

    assertThat(result).hasSize(1);
    AuditLogDTO dto = result.get(0);
    assertThat(dto.getId()).isEqualTo(9);
    assertThat(dto.getCreatedAt()).hasToString("2026-05-01T12:00:00Z");
    assertThat(dto.getActorEmail()).isEqualTo("a@test.ca");
    assertThat(dto.getAction()).isEqualTo("FORUM_DELETE");
    assertThat(dto.getEntityType()).isEqualTo("FORUM");
    assertThat(dto.getEntityId()).isEqualTo(3);
    assertThat(dto.getSummary()).isEqualTo("Forum #3 supprimé");
    assertThat(dto.getDetails()).isEqualTo("Cours : X");
  }

  @Test
  @DisplayName("search : type/q vides → filtres null ; limit ≤ 0 → 1 ; createdAt null → null")
  void search_filtres_vides() {
    AuditLog log = new AuditLog();
    log.setId(1);
    when(repository.search(isNull(), isNull(), isNull(), anyInt())).thenReturn(List.of(log));

    List<AuditLogDTO> result = auditLogService.search(null, " ", "", 0);

    ArgumentCaptor<Integer> limit = ArgumentCaptor.forClass(Integer.class);
    verify(repository).search(isNull(), isNull(), isNull(), limit.capture());
    assertThat(limit.getValue()).isEqualTo(1);
    assertThat(result.get(0).getCreatedAt()).isNull();

    auditLogService.search(null, null, null, 30);
    verify(repository).search(isNull(), isNull(), isNull(), eq(30));
    verify(repository, org.mockito.Mockito.never()).save(any());
  }
}
