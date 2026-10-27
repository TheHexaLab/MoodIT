package com.moodit.gateway.filter;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.Map;
import javax.crypto.SecretKey;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestClient;

class JwtAuthFilterTest {

  private static final String SECRET = "test-secret-suffisamment-longue-pour-hs256-0123456789";
  private static final String AUTH_URL = "http://localhost:8083";
  private static final String PERMISSION_URL = "http://localhost:8084";

  private JwtAuthFilter filter;
  private RestClient restClient;
  private RestClient.RequestBodySpec bodySpec;
  private RestClient.ResponseSpec responseSpec;

  @BeforeEach
  void setUp() {
    filter = new JwtAuthFilter();
    ReflectionTestUtils.setField(filter, "jwtSecret", SECRET);
    ReflectionTestUtils.setField(filter, "publicRoutesConfig", "/auth/login,/auth/register");
    ReflectionTestUtils.setField(filter, "authServiceUrl", AUTH_URL);
    ReflectionTestUtils.setField(filter, "permissionServiceUrl", PERMISSION_URL);
    // Par défaut (dev) : le header Bearer est toléré (Bruno / tests API).
    ReflectionTestUtils.setField(filter, "allowLegacyToken", true);
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

  // Branche le RestClient sur des mocks. L'appel /auth/validate renvoie `active`
  // (Boolean), ou lève si throwError. L'appel /permissions/validate (Map) autorise
  // par défaut ; les tests d'autorisation l'overrident via le champ `responseSpec`.
  private void stubValidate(Boolean active, boolean throwError) {
    restClient = mock(RestClient.class);
    RestClient.RequestBodyUriSpec uriSpec = mock(RestClient.RequestBodyUriSpec.class);
    bodySpec = mock(RestClient.RequestBodySpec.class);
    responseSpec = mock(RestClient.ResponseSpec.class);
    when(restClient.post()).thenReturn(uriSpec);
    when(uriSpec.uri(anyString())).thenReturn(bodySpec);
    when(bodySpec.header(anyString(), any())).thenReturn(bodySpec);
    when(bodySpec.body(any(Object.class))).thenReturn(bodySpec); // corps de l'appel permission
    when(bodySpec.retrieve()).thenReturn(responseSpec);
    if (throwError) {
      when(responseSpec.body(Boolean.class)).thenThrow(new RuntimeException("auth-service down"));
    } else {
      when(responseSpec.body(Boolean.class)).thenReturn(active);
    }
    // Par défaut, le permission-service autorise.
    when(responseSpec.body(Map.class)).thenReturn(Map.of("allowed", true));
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

  // Chemin protégé encodé : refusé avant tout (token, permission-service), sinon le contrôle
  // d'accès et le service en aval liraient deux chemins différents (/api/audit%2Dlogs).
  @Test
  void encodedProtectedPath_returns400_beforeAnyCheck() throws Exception {
    for (String uri : new String[] {"/api/audit%2Dlogs", "/api/quizzes/12/%65dit", "/api/x%252D"}) {
      MockHttpServletRequest req = new MockHttpServletRequest("GET", uri);
      req.addHeader("Authorization", "Bearer n-importe-quoi");
      MockFilterChain chain = new MockFilterChain();

      MockHttpServletResponse res = run(req, chain);

      assertThat(res.getStatus()).as(uri).isEqualTo(400);
      assertThat(res.getContentAsString()).contains("Chemin invalide");
      assertThat(chain.getRequest()).as(uri).isNull(); // bloqué
    }
  }

  // Paramètre texte non ASCII dans le chemin (nom accentué, #111) : la barrière le laisse passer,
  // la requête suit le parcours normal (ici : pas de token → 401, et non 400).
  @Test
  void nonAsciiEncodedPath_passesTheBarrier() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/users/%C3%A9l%C3%A8ve");
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(res.getContentAsString()).contains("Token manquant");
  }

  @Test
  void hasOnlyNonAsciiEncodings_acceptsValidUtf8Only() {
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/courses/12")).isTrue();
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%C3%A9")).isTrue();
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%c3%a9")).isTrue(); // hexa minuscule
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%C2%80")).isTrue(); // 1er non ASCII
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%E2%82%AC")).isTrue(); // €

    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%7F")).isFalse(); // dernier ASCII
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%C3")).isFalse(); // UTF-8 tronqué
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%C3%A")).isFalse(); // %xx incomplet
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%G9")).isFalse(); // non hexadécimal
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%9G")).isFalse();
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%A9")).isFalse(); // UTF-8 invalide
    assertThat(JwtAuthFilter.hasOnlyNonAsciiEncodings("/api/u/%C3x%A9")).isFalse(); // séquence coupée
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
  void validTokenInCookie_passesAndInjectsEmail() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.setCookies(new Cookie("moodit_token", validToken("cookie@usherbrooke.ca")));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    assertThat(forwarded.getHeader("X-User-Email")).isEqualTo("cookie@usherbrooke.ca");
  }

  @Test
  void cookieTakesPrecedenceOverHeader() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.setCookies(new Cookie("moodit_token", validToken("cookie@usherbrooke.ca")));
    req.addHeader("Authorization", "Bearer " + validToken("header@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    // Le cookie prime : l'email injecté vient du token du cookie, pas du header.
    assertThat(forwarded.getHeader("X-User-Email")).isEqualTo("cookie@usherbrooke.ca");
  }

  @Test
  void headerToken_rejectedWhenHeaderToleranceDisabled() throws Exception {
    // Prod (allowLegacyToken=false) : un token présenté en header seul est ignoré -> 401,
    // même valide. Seul le cookie compte.
    stubValidate(true, false);
    ReflectionTestUtils.setField(filter, "allowLegacyToken", false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + validToken("header@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(chain.getRequest()).isNull();
  }

  @Test
  void cookieToken_acceptedWhenHeaderToleranceDisabled() throws Exception {
    // Prod : le cookie reste le mécanisme normal, indépendant de la tolérance header.
    stubValidate(true, false);
    ReflectionTestUtils.setField(filter, "allowLegacyToken", false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.setCookies(new Cookie("moodit_token", validToken("cookie@usherbrooke.ca")));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    assertThat(forwarded.getHeader("X-User-Email")).isEqualTo("cookie@usherbrooke.ca");
  }

  @Test
  void blankCookie_fallsBackToHeader() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.setCookies(new Cookie("moodit_token", "")); // cookie vide -> ignoré, fallback header
    req.addHeader("Authorization", "Bearer " + validToken("header@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    assertThat(forwarded.getHeader("X-User-Email")).isEqualTo("header@usherbrooke.ca");
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

  @Test
  void permissionDenied_returns403() throws Exception {
    stubValidate(true, false); // token actif…
    when(responseSpec.body(Map.class)).thenReturn(Map.of("allowed", false)); // …mais accès refusé
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(403);
    assertThat(chain.getRequest()).isNull();
  }

  @Test
  void permissionServiceDown_returns503() throws Exception {
    stubValidate(true, false); // token actif…
    when(responseSpec.body(Map.class))
        .thenThrow(new RuntimeException("permission-service down")); // …mais permission injoignable
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(503);
    assertThat(chain.getRequest()).isNull();
  }

  @Test
  void permissionCall_forwardsPathMethodEtQueryString() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/roles");
    req.setQueryString("scope=global"); // getRequestURI() l'exclut : doit être transmis à part
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    run(req, chain);

    ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
    verify(bodySpec).body(captor.capture());
    Map<?, ?> payload = (Map<?, ?>) captor.getValue();
    assertThat(payload.get("email")).isEqualTo("user@usherbrooke.ca");
    assertThat(payload.get("path")).isEqualTo("/api/roles");
    assertThat(payload.get("method")).isEqualTo("GET");
    assertThat(payload.get("query")).isEqualTo("scope=global");
  }

  @Test
  void permissionCall_absenceDeQueryString_transmetChaineVide() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    // Pas de query string → le filtre doit envoyer "" (jamais null : Map.of interdit null).
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    run(req, chain);

    ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
    verify(bodySpec).body(captor.capture());
    Map<?, ?> payload = (Map<?, ?>) captor.getValue();
    assertThat(payload.get("query")).isEqualTo("");
  }

  @Test
  void postAvecBodyJson_transmisEtRelisableEnAval() throws Exception {
    stubValidate(true, false);
    String json = "{\"forumId\":42,\"content\":\"hi\"}";
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/forums/posts");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.setContentType("application/json");
    req.setContent(json.getBytes(StandardCharsets.UTF_8));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    assertThat(forwarded).isNotNull();
    // Le filtre a consommé le body pour permission ; core doit pouvoir le relire intact.
    String forwardedBody =
        new String(forwarded.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    assertThat(forwardedBody).isEqualTo(json);
  }

  // ------------------------------------------------------------------ branches complémentaires

  /** Corps transmis au permission-service pour une requête authentifiée. */
  private String forwardedPermissionBody() {
    ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
    verify(bodySpec).body(captor.capture());
    return (String) ((Map<?, ?>) captor.getValue()).get("body");
  }

  @Test
  void sousRoutePublique_passeSansToken() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/auth/register/confirm");
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    assertThat(chain.getRequest()).isNotNull();
  }

  @Test
  void prefixeSansSlash_nEstPasPublic() throws Exception {
    // "/auth/loginX" commence par "/auth/login" sans en être une sous-route : reste protégé.
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/auth/loginX");
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(chain.getRequest()).isNull();
  }

  @Test
  void bearerVide_returns401TokenManquant() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer   ");
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(res.getContentAsString()).contains("Token manquant");
    assertThat(chain.getRequest()).isNull();
  }

  @Test
  void headerAuthorizationNonBearer_ignore_returns401() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Basic " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(res.getContentAsString()).contains("Token manquant");
  }

  @Test
  void autreCookie_ignore_returns401() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.setCookies(new Cookie("autre_cookie", validToken("user@usherbrooke.ca")));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(chain.getRequest()).isNull();
  }

  @Test
  void tokenExpire_returns401SansAppelerAuthService() throws Exception {
    stubValidate(true, false);
    SecretKey key = Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8));
    String expired =
        Jwts.builder()
            .subject("user@usherbrooke.ca")
            .issuedAt(new Date(System.currentTimeMillis() - 7_200_000))
            .expiration(new Date(System.currentTimeMillis() - 3_600_000))
            .signWith(key)
            .compact();
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + expired);
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(res.getContentAsString()).contains("Token invalide");
    verifyNoInteractions(restClient);
  }

  @Test
  void reponsePermissionNulle_returns403() throws Exception {
    stubValidate(true, false);
    when(responseSpec.body(Map.class)).thenReturn(null); // corps vide : fail-closed
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(403);
    assertThat(res.getContentAsString()).contains("Accès refusé");
    assertThat(chain.getRequest()).isNull();
  }

  @Test
  void putJson_bodyTransmisAuPermissionService() throws Exception {
    assertJsonBodyForwardedFor("PUT");
  }

  @Test
  void patchJson_bodyTransmisAuPermissionService() throws Exception {
    assertJsonBodyForwardedFor("PATCH");
  }

  private void assertJsonBodyForwardedFor(String method) throws Exception {
    stubValidate(true, false);
    String json = "{\"courseId\":7}";
    MockHttpServletRequest req = new MockHttpServletRequest(method, "/api/courses/7");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.setContentType("APPLICATION/JSON;charset=UTF-8"); // casse indifférente
    req.setContent(json.getBytes(StandardCharsets.UTF_8));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    assertThat(forwardedPermissionBody()).isEqualTo(json);
  }

  @Test
  void postNonJson_bodyNonLuEtNonTransmis() throws Exception {
    // Texte / multipart : pas de mise en cache, le flux reste intact pour core.
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/files");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.setContentType("text/plain");
    req.setContent("brut".getBytes(StandardCharsets.UTF_8));
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    assertThat(forwardedPermissionBody()).isEmpty();
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    assertThat(new String(forwarded.getInputStream().readAllBytes(), StandardCharsets.UTF_8))
        .isEqualTo("brut");
  }

  @Test
  void postSansContentType_bodyNonTransmis() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/forums/posts");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.setContent("{}".getBytes(StandardCharsets.UTF_8));
    MockFilterChain chain = new MockFilterChain();

    run(req, chain);

    assertThat(forwardedPermissionBody()).isEmpty();
  }

  @Test
  void postJsonTropGros_bodyNonMisEnCache() throws Exception {
    // Garde-fou mémoire : au-delà de 1 Mo, le body n'est ni bufferisé ni transmis.
    stubValidate(true, false);
    byte[] big = new byte[1024 * 1024 + 1];
    java.util.Arrays.fill(big, (byte) 'a');
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/forums/posts");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.setContentType("application/json");
    req.setContent(big);
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    assertThat(forwardedPermissionBody()).isEmpty();
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    assertThat(forwarded.getInputStream().readAllBytes()).hasSize(big.length);
  }

  // Requête chunked (aucun Content-Length) au-delà de 1 Mo (#31) : la lecture est bornée, le
  // body n'est pas transmis au permission-service, et core le reçoit intact.
  @Test
  void postJsonChunkedTropGros_lectureBornee_bodyIntactEnAval() throws Exception {
    stubValidate(true, false);
    byte[] big = new byte[1024 * 1024 + 1];
    java.util.Arrays.fill(big, (byte) 'a');
    MockHttpServletRequest req = chunked("POST", "/api/forums/posts");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.setContentType("application/json");
    req.setContent(big);
    MockFilterChain chain = new MockFilterChain();

    MockHttpServletResponse res = run(req, chain);

    assertThat(res.getStatus()).isEqualTo(200);
    assertThat(forwardedPermissionBody()).isEmpty();
    HttpServletRequest forwarded = (HttpServletRequest) chain.getRequest();
    assertThat(forwarded.getInputStream().readAllBytes()).isEqualTo(big);
  }

  @Test
  void postJsonChunkedPetit_bodyTransmis() throws Exception {
    stubValidate(true, false);
    String json = "{\"forumId\":3}";
    MockHttpServletRequest req = chunked("POST", "/api/forums/posts");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.setContentType("application/json");
    req.setContent(json.getBytes(StandardCharsets.UTF_8));

    run(req, new MockFilterChain());

    assertThat(forwardedPermissionBody()).isEqualTo(json);
  }

  // Le body n'est lu qu'après l'authentification (#31) : sans token valide, il reste intact.
  @Test
  void tokenAbsent_bodyJamaisLu() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/forums/posts");
    req.setContentType("application/json");
    req.setContent("{\"forumId\":3}".getBytes(StandardCharsets.UTF_8));

    MockHttpServletResponse res = run(req, new MockFilterChain());

    assertThat(res.getStatus()).isEqualTo(401);
    assertThat(req.getInputStream().readAllBytes()).hasSize(13);
  }

  /** Requête sans Content-Length annoncé, comme un envoi chunked. */
  private static MockHttpServletRequest chunked(String method, String uri) {
    return new MockHttpServletRequest(method, uri) {
      @Override
      public long getContentLengthLong() {
        return -1;
      }

      @Override
      public int getContentLength() {
        return -1;
      }
    };
  }

  @Test
  void deleteAvecBodyJson_bodyNonTransmis() throws Exception {
    stubValidate(true, false);
    MockHttpServletRequest req = new MockHttpServletRequest("DELETE", "/api/courses/7");
    req.addHeader("Authorization", "Bearer " + validToken("user@usherbrooke.ca"));
    req.setContentType("application/json");
    req.setContent("{\"courseId\":7}".getBytes(StandardCharsets.UTF_8));
    MockFilterChain chain = new MockFilterChain();

    run(req, chain);

    assertThat(forwardedPermissionBody()).isEmpty();
  }
}
