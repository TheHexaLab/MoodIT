package com.moodit.gateway.filter;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import javax.crypto.SecretKey;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestClient;

class JwtAuthFilterTest {

  private static final String SECRET = "test-secret-suffisamment-longue-pour-hs256-0123456789";
  private static final String AUTH_URL = "http://localhost:8083";

  private JwtAuthFilter filter;
  private RestClient restClient;

  @BeforeEach
  void setUp() {
    filter = new JwtAuthFilter();
    ReflectionTestUtils.setField(filter, "jwtSecret", SECRET);
    ReflectionTestUtils.setField(filter, "publicRoutesConfig", "/auth/login,/auth/register");
    ReflectionTestUtils.setField(filter, "authServiceUrl", AUTH_URL);
  }

  private String validToken(String email) {
    SecretKey key = Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8));
    return Jwts.builder()
        .subject(email)
        .issuedAt(new Date())
        .expiration(new Date(System.currentTimeMillis() + 3_600_000))
        .signWith(key)
        .compact();
  }

  // Branche le RestClient (appel /auth/validate) sur un mock qui renvoie `active`, ou lève si null.
  private void stubValidate(Boolean active, boolean throwError) {
    restClient = mock(RestClient.class);
    RestClient.RequestBodyUriSpec uriSpec = mock(RestClient.RequestBodyUriSpec.class);
    RestClient.RequestBodySpec bodySpec = mock(RestClient.RequestBodySpec.class);
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
    ReflectionTestUtils.setField(filter, "restClient", restClient);
  }

  private MockHttpServletResponse run(MockHttpServletRequest req, MockFilterChain chain)
      throws ServletException, IOException {
    MockHttpServletResponse res = new MockHttpServletResponse();
    filter.doFilter(req, res, chain);
    return res;
  }

  @Test
  void publicRoute_passesWithoutToken() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/auth/login");
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    assertThat(chain.getRequest()).isNotNull(); // a bien traversé
  }

  @Test
  void missingToken_returns401() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(res.getContentAsString()).contains("Token manquant");
    assertThat(chain.getRequest()).isNull(); // bloqué
  }

  @Test
  void invalidSignature_returns401() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer pas.un.vrai.jwt");
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(res.getContentAsString()).contains("Token invalide");
  }

  @Test
  void validActiveToken_passesAndInjectsEmail() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    assertThat(chain.getRequest()).isNotNull();
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    assertThat(forwarded.getHeader("X-User-Email")).isEqualTo("user@usherbrooke.ca");
  }

  @Test
  void forgedEmailHeader_isOverwrittenByJwtSubject() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.addHeader("X-User-Email", "admin@usherbrooke.ca"); // tentative d'usurpation
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    // Singulier et pluriel doivent refléter le JWT, pas la valeur cliente.
    assertThat(forwarded.getHeader("X-User-Email")).isEqualTo("user@usherbrooke.ca");
    assertThat(java.util.Collections.list(forwarded.getHeaders("X-User-Email")))
        .containsExactly("user@usherbrooke.ca");
  }

  @Test
  void forgedEmailHeader_isStrippedOnPublicRoute() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/auth/login");
    req.addHeader("X-User-Email", "admin@usherbrooke.ca"); // injecté par le client
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    // Aucune valeur cliente ne doit fuiter en aval sur une route publique.
    assertThat(forwarded.getHeader("X-User-Email")).isNull();
    assertThat(forwarded.getHeaders("X-User-Email").hasMoreElements()).isFalse();
    assertThat(java.util.Collections.list(forwarded.getHeaderNames()))
        .doesNotContain("X-User-Email");
  }

  @Test
  void validButRevokedToken_returns401() throws Exception {
    stubValidate(false, false); // /auth/validate renvoie false
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(chain.getRequest()).isNull();
  }

  @Test
  void authServiceDown_returns503() throws Exception {
    stubValidate(null, true); // l'appel lève une exception
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(503);
    assertThat(chain.getRequest()).isNull();
  }
}
