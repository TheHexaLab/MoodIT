package com.moodit.core_service.controller;

import static org.mockito.Mockito.eq;
import static org.mockito.Mockito.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.AuditLogDTO;
import com.moodit.core_service.service.AuditLogService;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Contrat HTTP de {@link AuditLogController} : binding des query params (limit/beforeId/type/q) et
 * délégation à {@link AuditLogService#search}. Sécurité exclue (déléguée au permission-service).
 */
@WebMvcTest(
    controllers = AuditLogController.class,
    excludeAutoConfiguration = SecurityAutoConfiguration.class)
class AuditLogControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockitoBean private AuditLogService auditLogService;

  @Test
  void getLogs_sansParams_utiliseLesDefauts() throws Exception {
    AuditLogDTO dto =
        new AuditLogDTO(
            1,
            Instant.parse("2026-07-11T10:00:00Z"),
            "gardien@moodit.ca",
            "COURSE_UPDATE",
            "COURSE",
            12,
            "Cours mis à jour",
            "Programmes : X");
    when(auditLogService.search(isNull(), isNull(), isNull(), eq(30))).thenReturn(List.of(dto));

    mockMvc
        .perform(get("/api/audit-logs"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].id").value(1))
        .andExpect(jsonPath("$[0].summary").value("Cours mis à jour"))
        .andExpect(jsonPath("$[0].entityType").value("COURSE"))
        .andExpect(jsonPath("$[0].details").value("Programmes : X"));

    verify(auditLogService).search(isNull(), isNull(), isNull(), eq(30));
  }

  @Test
  void getLogs_transmetPaginationEtRecherche() throws Exception {
    when(auditLogService.search(eq(5), eq("COURSE"), eq("algo"), eq(10))).thenReturn(List.of());

    mockMvc
        .perform(get("/api/audit-logs?limit=10&beforeId=5&type=COURSE&q=algo"))
        .andExpect(status().isOk());

    verify(auditLogService).search(eq(5), eq("COURSE"), eq("algo"), eq(10));
  }
}
