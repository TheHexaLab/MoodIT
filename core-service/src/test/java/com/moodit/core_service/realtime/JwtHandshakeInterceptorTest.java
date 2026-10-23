// Authentification de l'ouverture du WebSocket : token en query param `token` (prioritaire) ou, à
// défaut, header Authorization Bearer. Token invalide/absent → 401 et upgrade refusé ; valide →
// email rangé dans les attributs de session. Validateur mocké (sa logique a ses propres tests).

package com.moodit.core_service.realtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.socket.WebSocketHandler;

class JwtHandshakeInterceptorTest {

  private WsJwtValidator validator;
  private JwtHandshakeInterceptor interceptor;
  private ServerHttpResponse response;
  private WebSocketHandler handler;
  private Map<String, Object> attributes;

  @BeforeEach
  void setUp() {
    validator = mock(WsJwtValidator.class);
    interceptor = new JwtHandshakeInterceptor(validator);
    response = mock(ServerHttpResponse.class);
    handler = mock(WebSocketHandler.class);
    attributes = new HashMap<>();
  }

  /** Requête servlet réelle vers /ws (query et header optionnels). */
  private ServletServerHttpRequest servletRequest(String query, String authorization) {
    MockHttpServletRequest raw = new MockHttpServletRequest("GET", "/ws");
    raw.setServerName("localhost");
    raw.setServerPort(8081);
    if (query != null) {
      raw.setQueryString(query);
    }
    if (authorization != null) {
      raw.addHeader("Authorization", authorization);
    }
    return new ServletServerHttpRequest(raw);
  }

  @Test
  @DisplayName("Token valide en query param → upgrade accepté, email en attribut de session")
  void tokenEnQuery_accepte() {
    when(validator.validateAndGetEmail("abc.def.ghi")).thenReturn("rosie@usherbrooke.ca");

    boolean accepted =
        interceptor.beforeHandshake(servletRequest("token=abc.def.ghi", null), response, handler, attributes);

    assertThat(accepted).isTrue();
    assertThat(attributes)
        .containsEntry(JwtHandshakeInterceptor.USER_EMAIL_ATTRIBUTE, "rosie@usherbrooke.ca");
    verify(response, never()).setStatusCode(any());
  }

  @Test
  @DisplayName("Query param prioritaire sur le header Authorization")
  void queryPrioritaireSurHeader() {
    when(validator.validateAndGetEmail("from-query")).thenReturn("a@test.ca");

    interceptor.beforeHandshake(
        servletRequest("token=from-query", "Bearer from-header"), response, handler, attributes);

    verify(validator).validateAndGetEmail("from-query");
    verify(validator, never()).validateAndGetEmail("from-header");
  }

  @Test
  @DisplayName("Pas de query param → repli sur le header Authorization Bearer")
  void repliSurHeaderBearer() {
    when(validator.validateAndGetEmail("jwt-header")).thenReturn("b@test.ca");

    boolean accepted =
        interceptor.beforeHandshake(servletRequest(null, "Bearer jwt-header"), response, handler, attributes);

    assertThat(accepted).isTrue();
    assertThat(attributes).containsEntry(JwtHandshakeInterceptor.USER_EMAIL_ATTRIBUTE, "b@test.ca");
  }

  @Test
  @DisplayName("Query param vide → repli sur le header")
  void queryVide_repliSurHeader() {
    when(validator.validateAndGetEmail("jwt-header")).thenReturn("b@test.ca");

    assertThat(interceptor.beforeHandshake(
        servletRequest("token=", "Bearer jwt-header"), response, handler, attributes)).isTrue();
  }

  @Test
  @DisplayName("Header sans préfixe Bearer → aucun token, 401")
  void headerSansBearer_refuse() {
    boolean accepted =
        interceptor.beforeHandshake(servletRequest(null, "Basic xyz"), response, handler, attributes);

    assertThat(accepted).isFalse();
    verify(validator).validateAndGetEmail(null);
    verify(response).setStatusCode(HttpStatus.UNAUTHORIZED);
    assertThat(attributes).isEmpty();
  }

  @Test
  @DisplayName("Token invalide → 401 et upgrade refusé")
  void tokenInvalide_refuse() {
    when(validator.validateAndGetEmail("forged")).thenReturn(null);

    boolean accepted =
        interceptor.beforeHandshake(servletRequest("token=forged", null), response, handler, attributes);

    assertThat(accepted).isFalse();
    verify(response).setStatusCode(HttpStatus.UNAUTHORIZED);
    assertThat(attributes).doesNotContainKey(JwtHandshakeInterceptor.USER_EMAIL_ATTRIBUTE);
  }

  @Test
  @DisplayName("Requête non servlet sans query param → pas de header lu, 401")
  void requeteNonServlet_refuse() {
    ServerHttpRequest request = mock(ServerHttpRequest.class);
    when(request.getURI()).thenReturn(URI.create("ws://localhost:8081/ws"));

    boolean accepted = interceptor.beforeHandshake(request, response, handler, attributes);

    assertThat(accepted).isFalse();
    verify(validator).validateAndGetEmail(null);
    verify(response).setStatusCode(HttpStatus.UNAUTHORIZED);
  }

  @Test
  @DisplayName("afterHandshake ne touche à rien")
  void afterHandshake_sansEffet() {
    ServerHttpRequest request = mock(ServerHttpRequest.class);

    interceptor.afterHandshake(request, response, handler, null);

    verifyNoInteractions(request, response, handler, validator);
  }
}
