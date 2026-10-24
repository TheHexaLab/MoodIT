package com.moodit.permission_service.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.permission_service.service.MembershipService;
import com.moodit.permission_service.service.PermissionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * Couche web des deux points de décision (#90) : POST /permissions/validate (REST, appelé par le
 * gateway) et POST /permissions/can-join (rooms WebSocket). MockMvc standalone, services mockés :
 * on vérifie le contrat HTTP — 200 + {"allowed": true|false} relayant la décision, transmission
 * fidèle des champs au service, et 4xx (sans consulter le service) sur une requête invalide.
 *
 * <p>Rappel : côté gateway, seul {@code allowed == true} laisse passer ; tout autre statut ou
 * corps est traité comme un refus (fail-closed).
 */
@ExtendWith(MockitoExtension.class)
class PermissionControllerTest {

  @Mock private PermissionService permissionService;
  @Mock private MembershipService membershipService;

  private MockMvc mockMvc;

  @BeforeEach
  void setUp() {
    mockMvc =
        MockMvcBuilders.standaloneSetup(
                new PermissionController(permissionService, membershipService))
            .build();
  }

  // ── POST /permissions/validate ─────────────────────────────────────────────────────

  @Test
  void validate_decisionPositive_200AllowedTrue() throws Exception {
    when(permissionService.isAllowed("u@test", "/api/audit-logs", "GET", "", "action=ROLE_ASSIGN"))
        .thenReturn(true);

    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"email\":\"u@test\",\"path\":\"/api/audit-logs\",\"method\":\"GET\","
                        + "\"body\":\"\",\"query\":\"action=ROLE_ASSIGN\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.allowed").value(true));
  }

  @Test
  void validate_decisionNegative_200AllowedFalse() throws Exception {
    when(permissionService.isAllowed("u@test", "/api/audit-logs", "GET", null, null))
        .thenReturn(false);

    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"path\":\"/api/audit-logs\",\"method\":\"GET\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.allowed").value(false));
  }

  @Test
  void validate_transmetLeBodyBrutAuService() throws Exception {
    // Le body JSON de la requête d'origine est passé TEL QUEL (chaîne) au moteur.
    when(permissionService.isAllowed("u@test", "/api/forums/posts", "POST", "{\"forumId\":9}", null))
        .thenReturn(true);

    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"email\":\"u@test\",\"path\":\"/api/forums/posts\",\"method\":\"POST\","
                        + "\"body\":\"{\\\"forumId\\\":9}\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.allowed").value(true));

    verify(permissionService)
        .isAllowed("u@test", "/api/forums/posts", "POST", "{\"forumId\":9}", null);
  }

  @Test
  void validate_emailManquant_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"path\":\"/api/audit-logs\",\"method\":\"GET\"}"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(permissionService);
  }

  @Test
  void validate_emailVide_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"  \",\"path\":\"/api/me\",\"method\":\"PATCH\"}"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(permissionService);
  }

  @Test
  void validate_cheminManquant_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"method\":\"GET\"}"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(permissionService);
  }

  @Test
  void validate_methodeManquante_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"path\":\"/api/me\"}"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(permissionService);
  }

  @Test
  void validate_jsonMalforme_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(permissionService);
  }

  @Test
  void validate_corpsAbsent_400SansDecision() throws Exception {
    mockMvc
        .perform(post("/permissions/validate").contentType(MediaType.APPLICATION_JSON))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(permissionService);
  }

  @Test
  void validate_verbeGet_405() throws Exception {
    mockMvc.perform(get("/permissions/validate")).andExpect(status().isMethodNotAllowed());
    verifyNoInteractions(permissionService);
  }

  @Test
  void validate_contentTypeNonJson_415() throws Exception {
    mockMvc
        .perform(
            post("/permissions/validate").contentType(MediaType.TEXT_PLAIN).content("email=u@test"))
        .andExpect(status().isUnsupportedMediaType());
    verifyNoInteractions(permissionService);
  }

  // ── POST /permissions/can-join ─────────────────────────────────────────────────────

  @Test
  void canJoin_decisionPositive_200AllowedTrue() throws Exception {
    when(membershipService.canJoin("u@test", "forum", 9L)).thenReturn(true);

    mockMvc
        .perform(
            post("/permissions/can-join")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"scope\":\"forum\",\"id\":9}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.allowed").value(true));
  }

  @Test
  void canJoin_decisionNegative_200AllowedFalse() throws Exception {
    when(membershipService.canJoin("u@test", "adminRoles", 0L)).thenReturn(false);

    mockMvc
        .perform(
            post("/permissions/can-join")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"scope\":\"adminRoles\",\"id\":0}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.allowed").value(false));
  }

  @Test
  void canJoin_idManquant_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/can-join")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"scope\":\"forum\"}"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(membershipService);
  }

  @Test
  void canJoin_scopeVide_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/can-join")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"scope\":\"\",\"id\":9}"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(membershipService);
  }

  @Test
  void canJoin_emailManquant_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/can-join")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"scope\":\"forum\",\"id\":9}"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(membershipService);
  }

  @Test
  void canJoin_idNonNumerique_400SansDecision() throws Exception {
    mockMvc
        .perform(
            post("/permissions/can-join")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"scope\":\"forum\",\"id\":\"neuf\"}"))
        .andExpect(status().isBadRequest());
    verifyNoInteractions(membershipService);
  }

  @Test
  void lesDeuxPointsDeDecisionSontIndependants() throws Exception {
    // can-join ne consulte jamais PermissionService ; validate jamais MembershipService en direct.
    when(membershipService.canJoin(anyString(), anyString(), anyLong())).thenReturn(true);
    mockMvc
        .perform(
            post("/permissions/can-join")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"scope\":\"user\",\"id\":5}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.allowed").value(true));
    verifyNoInteractions(permissionService);

    when(permissionService.isAllowed(anyString(), anyString(), anyString(), any(), isNull()))
        .thenReturn(false);
    mockMvc
        .perform(
            post("/permissions/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"u@test\",\"path\":\"/api/x\",\"method\":\"DELETE\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.allowed").value(false));
    verify(membershipService).canJoin("u@test", "user", 5L);
  }
}
