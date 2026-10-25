package com.moodit.auth_service.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.moodit.auth_service.service.AuthService;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

class AuthDevControllerTest {

  @Test
  void verifyDev_delegatesToService_andReturns200() {
    AuthService authService = mock(AuthService.class);
    when(authService.verifyDev("rkarine")).thenReturn(Map.of("message", "Email vérifié pour rkarine"));

    ResponseEntity<Map<String, String>> res = new AuthDevController(authService).verifyDev("rkarine");

    assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
    assertThat(res.getBody()).containsEntry("message", "Email vérifié pour rkarine");
  }

  @Test
  void controller_isRestrictedToDevProfile() {
    // Garde-fou : /auth/verify/{username} contourne la vérification email, il ne doit
    // jamais exister hors profil dev.
    Profile profile = AuthDevController.class.getAnnotation(Profile.class);

    assertThat(profile).isNotNull();
    assertThat(profile.value()).containsExactly("dev");
  }
}
