package com.moodit.auth_service.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.auth_service.controller.AuthController;
import com.moodit.auth_service.service.AuthService;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

// Chaîne de sécurité RÉELLE (filtres actifs, contrairement à AuthControllerTest) : routes
// publiques accessibles sans jeton ni CSRF, toute autre route refusée, aucune session HTTP.
@WebMvcTest(AuthController.class)
@Import(SecurityConfig.class)
class SecurityConfigTest {

  @Autowired private MockMvc mockMvc;
  @Autowired private PasswordEncoder passwordEncoder;

  @MockitoBean private AuthService authService;
  @MockitoBean private AuthCookie authCookie;

  @Test
  void publicRoute_isReachable_withoutAuthNorCsrfToken() throws Exception {
    // CSRF désactivé : un POST sans jeton CSRF ne doit pas être bloqué (403).
    mockMvc.perform(post("/auth/validate")).andExpect(status().isOk()).andExpect(content().string("false"));
  }

  @Test
  void publicWriteRoute_forgotPassword_isReachableAnonymously() throws Exception {
    when(authService.forgotPassword("karine@usherbrooke.ca")).thenReturn(Map.of("message", "ok"));

    mockMvc
        .perform(
            post("/auth/forgot-password")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"karine@usherbrooke.ca\"}"))
        .andExpect(status().isOk());
    verify(authService).forgotPassword("karine@usherbrooke.ca");
  }

  @Test
  void logout_isPublic() throws Exception {
    when(authCookie.clear()).thenReturn(ResponseCookie.from(AuthCookie.NAME, "").maxAge(0).build());

    mockMvc.perform(post("/auth/logout")).andExpect(status().isOk());
    verify(authService).logout(any());
  }

  @Test
  void nonPublicRoute_isRejected_whenAnonymous() throws Exception {
    // anyRequest().authenticated() : une route hors liste blanche est refusée sans authentification.
    MvcResult res = mockMvc.perform(get("/auth/admin")).andReturn();

    assertThat(res.getResponse().getStatus()).isIn(401, 403);
  }

  @Test
  void stateless_noHttpSessionCreated() throws Exception {
    MvcResult res = mockMvc.perform(post("/auth/validate")).andReturn();

    assertThat(res.getRequest().getSession(false)).isNull();
  }

  @Test
  void passwordEncoder_isBCrypt() {
    String hash = passwordEncoder.encode("Sup3rPass!");

    assertThat(passwordEncoder).isInstanceOf(BCryptPasswordEncoder.class);
    assertThat(hash).startsWith("$2");
    assertThat(passwordEncoder.matches("Sup3rPass!", hash)).isTrue();
    assertThat(passwordEncoder.matches("autre", hash)).isFalse();
  }
}
