package com.moodit.auth_service.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseCookie;

class AuthCookieTest {

  @Test
  void build_hasSecurityAttributes_secureFalseInDev() {
    ResponseCookie c = new AuthCookie(false, 3_600_000L).build("jwt-token");

    assertThat(c.getName()).isEqualTo("moodit_token");
    assertThat(c.getValue()).isEqualTo("jwt-token");
    assertThat(c.isHttpOnly()).isTrue(); // invisible au JS
    assertThat(c.isSecure()).isFalse(); // dev http
    assertThat(c.getSameSite()).isEqualTo("Strict"); // anti-CSRF
    assertThat(c.getPath()).isEqualTo("/");
    assertThat(c.getMaxAge()).isEqualTo(Duration.ofSeconds(3600)); // dérivé de jwt.expiration
  }

  @Test
  void build_secureTrueInProd() {
    ResponseCookie c = new AuthCookie(true, 3_600_000L).build("jwt");
    assertThat(c.isSecure()).isTrue();
  }

  @Test
  void clear_isEmptyWithZeroMaxAge_andSameAttributes() {
    // Le logout (autre membre) réutilise clear() : mêmes attributs, sinon le navigateur
    // n'efface pas le cookie.
    ResponseCookie c = new AuthCookie(true, 3_600_000L).clear();

    assertThat(c.getValue()).isEmpty();
    assertThat(c.getMaxAge()).isEqualTo(Duration.ZERO); // suppression immédiate
    assertThat(c.isHttpOnly()).isTrue();
    assertThat(c.isSecure()).isTrue();
    assertThat(c.getSameSite()).isEqualTo("Strict");
    assertThat(c.getPath()).isEqualTo("/");
  }
}
