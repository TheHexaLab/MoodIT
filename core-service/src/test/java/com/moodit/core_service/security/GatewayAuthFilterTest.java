package com.moodit.core_service.security;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * {@link GatewayAuthFilter} : l'identité vient UNIQUEMENT du header {@code X-User-Email} posé par
 * le gateway. Header présent → principal = cet email ; absent ou blanc → aucune authentification.
 * La chaîne est toujours poursuivie (le refus éventuel est l'affaire de la config de sécurité).
 */
class GatewayAuthFilterTest {

  private final GatewayAuthFilter filter = new GatewayAuthFilter();

  @AfterEach
  void clear() {
    SecurityContextHolder.clearContext();
  }

  private MockFilterChain run(MockHttpServletRequest request) throws Exception {
    MockFilterChain chain = new MockFilterChain();
    filter.doFilter(request, new MockHttpServletResponse(), chain);
    return chain;
  }

  @Test
  @DisplayName("Header X-User-Email présent → authentifié avec cet email pour principal")
  void headerPresent_authentifie() throws Exception {
    MockHttpServletRequest request = new MockHttpServletRequest();
    request.addHeader(GatewayAuthFilter.USER_EMAIL_HEADER, "eva@test.ca");

    MockFilterChain chain = run(request);

    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    assertThat(auth).isNotNull();
    assertThat(auth.getName()).isEqualTo("eva@test.ca");
    assertThat(auth.isAuthenticated()).isTrue();
    assertThat(auth.getAuthorities()).isEmpty();
    assertThat(chain.getRequest()).isSameAs(request);
  }

  @Test
  @DisplayName("Header absent → aucune authentification, la chaîne continue")
  void headerAbsent_anonyme() throws Exception {
    MockFilterChain chain = run(new MockHttpServletRequest());

    assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    assertThat(chain.getRequest()).isNotNull();
  }

  @Test
  @DisplayName("Header blanc → aucune authentification (pas de principal vide)")
  void headerBlanc_anonyme() throws Exception {
    MockHttpServletRequest request = new MockHttpServletRequest();
    request.addHeader(GatewayAuthFilter.USER_EMAIL_HEADER, "   ");

    FilterChain chain = run(request);

    assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    assertThat(((MockFilterChain) chain).getRequest()).isSameAs(request);
  }
}
