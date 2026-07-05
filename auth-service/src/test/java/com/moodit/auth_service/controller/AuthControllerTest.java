package com.moodit.auth_service.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.auth_service.config.AuthCookie;
import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.RegisterRequest;
import com.moodit.auth_service.exception.DomainNotAllowedException;
import com.moodit.auth_service.exception.EmailAlreadyUsedException;
import com.moodit.auth_service.exception.InvalidCredentialsException;
import com.moodit.auth_service.exception.TooManyRequestsException;
import com.moodit.auth_service.service.AuthService;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

// Test d'intégration de la couche web : vérifie le mapping exception -> statut HTTP
// par le GlobalExceptionHandler. Filtres de sécurité désactivés pour cibler le controller.
@WebMvcTest(AuthController.class)
@AutoConfigureMockMvc(addFilters = false)
class AuthControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockitoBean private AuthService authService;

  @MockitoBean private AuthCookie authCookie;

  private static final String VALID_BODY =
      """
      {"username":"rkarine","firstName":"Karine","lastName":"Roussel",
       "email":"karine@usherbrooke.ca","password":"Sup3rPass!"}
      """;

  @Test
  void register_valid_returns200() throws Exception {
    when(authService.register(any(RegisterRequest.class))).thenReturn(Map.of("message", "ok"));

    mockMvc
        .perform(post("/auth/register").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
        .andExpect(status().isOk());
  }

  @Test
  void register_invalidBody_returns400() throws Exception {
    // username trop court + email invalide + password trop court -> @Valid échoue
    String bad = "{\"username\":\"a\",\"firstName\":\"\",\"lastName\":\"\",\"email\":\"x\",\"password\":\"123\"}";

    mockMvc
        .perform(post("/auth/register").contentType(MediaType.APPLICATION_JSON).content(bad))
        .andExpect(status().isBadRequest());
  }

  // EmailAlreadyUsedException n'est plus levée par register (anti-énumération : register
  // renvoie un succès générique). Elle subsiste comme garde anti-course dans verifyEmail.
  // Ce test couvre uniquement le mapping de l'exception -> 409 par le GlobalExceptionHandler.
  @Test
  void emailAlreadyUsedException_mapsTo409() throws Exception {
    when(authService.register(any())).thenThrow(new EmailAlreadyUsedException());

    mockMvc
        .perform(post("/auth/register").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
        .andExpect(status().isConflict());
  }

  @Test
  void register_domainNotAllowed_returns403() throws Exception {
    when(authService.register(any())).thenThrow(new DomainNotAllowedException());

    mockMvc
        .perform(post("/auth/register").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
        .andExpect(status().isForbidden());
  }

  @Test
  void login_invalidCredentials_returns401() throws Exception {
    when(authService.login(any())).thenThrow(new InvalidCredentialsException());
    String body = "{\"email\":\"karine@usherbrooke.ca\",\"password\":\"Sup3rPass!\"}";

    mockMvc
        .perform(post("/auth/login").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void validate_validBearer_stripsOnlyPrefix_andDelegates() throws Exception {
    // Le token passé au service doit être exactement substring(7), sans toucher au reste.
    when(authService.validate("abc.def.ghi")).thenReturn(true);

    mockMvc
        .perform(post("/auth/validate").header("Authorization", "Bearer abc.def.ghi"))
        .andExpect(status().isOk())
        .andExpect(content().string("true"));
  }

  @Test
  void validate_missingHeader_returnsFalse_withoutCallingService() throws Exception {
    mockMvc
        .perform(post("/auth/validate"))
        .andExpect(status().isOk())
        .andExpect(content().string("false"));

    verify(authService, never()).validate(anyString());
  }

  @Test
  void validate_malformedHeader_returnsFalse_withoutCallingService() throws Exception {
    mockMvc
        .perform(post("/auth/validate").header("Authorization", "abc.def.ghi"))
        .andExpect(status().isOk())
        .andExpect(content().string("false"));

    verify(authService, never()).validate(anyString());
  }

  @Test
  void verify2FA_success_setsCookie_andKeepsTokenInBody() throws Exception {
    // Bascule douce : le token doit être posé en cookie ET rester dans le body.
    when(authService.verify2FA("karine@usherbrooke.ca", "123456"))
        .thenReturn(
            new AuthResponse("jwt-token", "rkarine", "karine@usherbrooke.ca", "Karine", "Roussel"));
    when(authCookie.build("jwt-token"))
        .thenReturn(ResponseCookie.from("moodit_token", "jwt-token").httpOnly(true).build());
    String body = "{\"email\":\"karine@usherbrooke.ca\",\"code\":\"123456\"}";

    mockMvc
        .perform(post("/auth/verify-2fa").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isOk())
        .andExpect(header().string(HttpHeaders.SET_COOKIE, containsString("moodit_token=jwt-token")))
        .andExpect(content().json("{\"token\":\"jwt-token\"}"));
  }

  @Test
  void verify2FA_malformedCode_returns400() throws Exception {
    String body = "{\"email\":\"karine@usherbrooke.ca\",\"code\":\"12\"}"; // pas 6 chiffres

    mockMvc
        .perform(post("/auth/verify-2fa").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isBadRequest());
  }

  @Test
  void verifyEmail_missingEmail_returns400() throws Exception {
    String body = "{\"code\":\"123456\"}"; // email manquant

    mockMvc
        .perform(post("/auth/verify-email").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isBadRequest());
  }

  @Test
  void resendCode_invalidMode_returns400() throws Exception {
    String body = "{\"email\":\"karine@usherbrooke.ca\",\"mode\":\"sms\"}"; // mode hors {email,2fa}

    mockMvc
        .perform(post("/auth/resend-code").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isBadRequest());
  }

  @Test
  void resendCode_tooManyRequests_returns429() throws Exception {
    when(authService.resendCode(anyString(), anyString()))
        .thenThrow(new TooManyRequestsException("Patientez."));
    String body = "{\"email\":\"karine@usherbrooke.ca\",\"mode\":\"email\"}";

    mockMvc
        .perform(post("/auth/resend-code").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isTooManyRequests());
  }
}
