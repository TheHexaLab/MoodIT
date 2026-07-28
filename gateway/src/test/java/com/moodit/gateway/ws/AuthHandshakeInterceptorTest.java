package com.moodit.gateway.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import jakarta.servlet.http.Cookie;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestClient;

/**
 * Point d'auth UNIQUE du temps réel : on couvre absence de token (401), token valide (true +
 * rangé dans les attributs), token inactif (401), auth-service injoignable (503, fail-closed),
 * précédence cookie > query, et le verrou legacy (query ?token= accepté en dev, rejeté en prod).
 */
class AuthHandshakeInterceptorTest {

  private static final String AUTH_URL = "http://localhost:8083";

  private AuthHandshakeInterceptor interceptor;
  private RestClient.RequestBodyUriSpec uriSpec;
  private RestClient.RequestBodySpec bodySpec;

  @BeforeEach
  void setUp() {
    interceptor = new AuthHandshakeInterceptor();
    ReflectionTestUtils.setField(interceptor, "authServiceUrl", AUTH_URL);
    ReflectionTestUtils.setField(interceptor, "allowLegacyToken", true);
  }

  /** Branche le RestClient sur des mocks : /auth/validate renvoie `active`, ou lève si throwError. */
  private void stubActive(Boolean active, boolean throwError) {
    RestClient restClient = mock(RestClient.class);
    uriSpec = mock(RestClient.RequestBodyUriSpec.class);
    bodySpec = mock(RestClient.RequestBodySpec.class);
    RestClient.ResponseSpec responseSpec = mock(RestClient.ResponseSpec.class);
    when(restClient.post()).thenReturn(uriSpec);
    when(uriSpec.uri(anyString())).thenReturn(bodySpec);
    when(bodySpec.header(anyString(), any())).thenReturn(bodySpec);
    when(bodySpec.retrieve()).thenReturn(responseSpec);
    if (throwError) {
      when(responseSpec.body(Boolean.class)).thenThrow(new RuntimeException("auth-service down"));
    } else {
      when(responseSpec.body(Boolean.class)).thenReturn(active);
    }
    ReflectionTestUtils.setField(interceptor, "restClient", restClient);
  }

  private ServletServerHttpRequest request(String cookieToken, String queryToken) {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/ws");
    req.setServerName("app.example.com");
    if (cookieToken != null) {
      req.setCookies(new Cookie("moodit_token", cookieToken));
    }
    if (queryToken != null) {
      req.setQueryString("token=" + queryToken);
    }
    return new ServletServerHttpRequest(req);
  }

  private boolean handshake(ServletServerHttpRequest req, MockHttpServletResponse raw, Map<String, Object> attrs) {
    return interceptor.beforeHandshake(req, new ServletServerHttpResponse(raw), null, attrs);
  }

  @Test
  void noToken_returns401() {
    MockHttpServletResponse res = new MockHttpServletResponse();
    Map<String, Object> attrs = new HashMap<>();

    boolean ok = handshake(request(null, null), res, attrs);

    assertThat(ok).isFalse();
    assertThat(res.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED.value());
    assertThat(attrs).isEmpty();
  }

  @Test
  void validCookieToken_allowedAndStored() {
    stubActive(true, false);
    MockHttpServletResponse res = new MockHttpServletResponse();
    Map<String, Object> attrs = new HashMap<>();

    boolean ok = handshake(request("tok", null), res, attrs);

    assertThat(ok).isTrue();
    assertThat(attrs.get(AuthHandshakeInterceptor.TOKEN_ATTR)).isEqualTo("tok");
  }

  @Test
  void callsAuthValidate_withCorrectUri_andBearerToken() {
    // Régression : vérifie l'ENDPOINT et le HEADER exacts (pas juste "un appel a eu lieu").
    stubActive(true, false);
    Map<String, Object> attrs = new HashMap<>();

    handshake(request("tok", null), new MockHttpServletResponse(), attrs);

    verify(uriSpec).uri(AUTH_URL + "/auth/validate");
    ArgumentCaptor<String> value = ArgumentCaptor.forClass(String.class);
    verify(bodySpec).header(eq("Authorization"), value.capture());
    assertThat(value.getValue()).isEqualTo("Bearer tok");
  }

  @Test
  void inactiveToken_returns401() {
    stubActive(false, false); // token connu mais révoqué / session remplacée
    MockHttpServletResponse res = new MockHttpServletResponse();
    Map<String, Object> attrs = new HashMap<>();

    boolean ok = handshake(request("tok", null), res, attrs);

    assertThat(ok).isFalse();
    assertThat(res.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED.value());
    assertThat(attrs).isEmpty();
  }

  @Test
  void authServiceDown_returns503_failClosed() {
    stubActive(null, true);
    MockHttpServletResponse res = new MockHttpServletResponse();
    Map<String, Object> attrs = new HashMap<>();

    boolean ok = handshake(request("tok", null), res, attrs);

    assertThat(ok).isFalse();
    assertThat(res.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE.value());
    assertThat(attrs).isEmpty();
  }

  @Test
  void queryToken_whenLegacyAllowed_used() {
    ReflectionTestUtils.setField(interceptor, "allowLegacyToken", true);
    stubActive(true, false);
    MockHttpServletResponse res = new MockHttpServletResponse();
    Map<String, Object> attrs = new HashMap<>();

    boolean ok = handshake(request(null, "qtok"), res, attrs);

    assertThat(ok).isTrue();
    assertThat(attrs.get(AuthHandshakeInterceptor.TOKEN_ATTR)).isEqualTo("qtok");
  }

  @Test
  void queryToken_whenLegacyDisabled_denied() {
    // Prod : cookie-only. Un ?token= n'est plus accepté → aucun token → 401.
    ReflectionTestUtils.setField(interceptor, "allowLegacyToken", false);
    MockHttpServletResponse res = new MockHttpServletResponse();
    Map<String, Object> attrs = new HashMap<>();

    boolean ok = handshake(request(null, "qtok"), res, attrs);

    assertThat(ok).isFalse();
    assertThat(res.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED.value());
    assertThat(attrs).isEmpty();
  }

  @Test
  void cookieTakesPrecedenceOverQuery() {
    stubActive(true, false);
    MockHttpServletResponse res = new MockHttpServletResponse();
    Map<String, Object> attrs = new HashMap<>();

    boolean ok = handshake(request("ctok", "qtok"), res, attrs);

    assertThat(ok).isTrue();
    assertThat(attrs.get(AuthHandshakeInterceptor.TOKEN_ATTR)).isEqualTo("ctok");
  }

  @Test
  void blankCookie_fallsBackToQuery_whenLegacyAllowed() {
    stubActive(true, false);
    MockHttpServletResponse res = new MockHttpServletResponse();
    Map<String, Object> attrs = new HashMap<>();

    boolean ok = handshake(request("", "qtok"), res, attrs);

    assertThat(ok).isTrue();
    assertThat(attrs.get(AuthHandshakeInterceptor.TOKEN_ATTR)).isEqualTo("qtok");
  }
}
