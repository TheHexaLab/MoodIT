package com.moodit.gateway.filter;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * Origine des écritures (#234) : seule une origine autorisée (ou aucune, hors navigateur) peut
 * envoyer un POST, PUT, PATCH ou DELETE ; les lectures ne sont jamais filtrées.
 */
class OriginCheckFilterTest {

  private static final String FRONT = "https://moodit.ca";

  private final OriginCheckFilter filter =
      new OriginCheckFilter(FRONT + ", https://www.moodit.ca");

  /** Passe la requête au filtre ; renvoie la réponse, et si la chaîne a été appelée. */
  private Result run(String method, String origin, String fetchSite) throws Exception {
    MockHttpServletRequest request = new MockHttpServletRequest(method, "/api/posts");
    if (origin != null) request.addHeader("Origin", origin);
    if (fetchSite != null) request.addHeader("Sec-Fetch-Site", fetchSite);
    MockHttpServletResponse response = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();
    filter.doFilter(request, response, chain);
    return new Result(response, chain.getRequest() != null);
  }

  private record Result(MockHttpServletResponse response, boolean passed) {}

  @ParameterizedTest
  @ValueSource(strings = {"POST", "PUT", "PATCH", "DELETE"})
  @DisplayName("écriture depuis le front autorisé : transmise")
  void ecritureDuFront_passe(String method) throws Exception {
    Result result = run(method, FRONT, "same-origin");
    assertThat(result.passed()).isTrue();
    assertThat(result.response().getStatus()).isEqualTo(200);
  }

  @ParameterizedTest
  @ValueSource(strings = {"POST", "PUT", "PATCH", "DELETE"})
  @DisplayName("écriture depuis une autre origine (même un sous-domaine) : 403, jamais transmise")
  void ecritureDAutreOrigine_refusee(String method) throws Exception {
    for (String origin : new String[] {"https://evil.example", "https://livekit.moodit.ca", "null"}) {
      Result result = run(method, origin, null);
      assertThat(result.passed()).as(origin).isFalse();
      assertThat(result.response().getStatus()).as(origin).isEqualTo(403);
      assertThat(result.response().getContentAsString()).isEqualTo("Origine refusée");
    }
  }

  @Test
  @DisplayName("toutes les origines de la liste sont acceptées, sans égard à la casse ni à la barre finale")
  void listeEtNormalisation() throws Exception {
    assertThat(run("POST", "https://www.moodit.ca", null).passed()).isTrue();
    assertThat(run("POST", "HTTPS://MOODIT.CA/", null).passed()).isTrue();
  }

  @ParameterizedTest
  @ValueSource(strings = {"GET", "HEAD", "OPTIONS"})
  @DisplayName("lecture : jamais filtrée, quelle que soit l'origine")
  void lecture_jamaisFiltree(String method) throws Exception {
    assertThat(run(method, "https://evil.example", "cross-site").passed()).isTrue();
  }

  @Test
  @DisplayName("écriture sans Origin (outil, appel serveur) : transmise")
  void sansOrigin_passe() throws Exception {
    assertThat(run("POST", null, null).passed()).isTrue();
    assertThat(run("POST", null, "same-origin").passed()).isTrue();
    assertThat(run("POST", null, "none").passed()).isTrue();
  }

  @ParameterizedTest
  @ValueSource(strings = {"cross-site", "same-site", "CROSS-SITE"})
  @DisplayName("écriture sans Origin mais déclarée venue d'un autre site : 403")
  void sansOriginMaisAutreSite_refusee(String fetchSite) throws Exception {
    Result result = run("POST", null, fetchSite);
    assertThat(result.passed()).isFalse();
    assertThat(result.response().getStatus()).isEqualTo(403);
  }

  @Test
  @DisplayName("liste d'origines vide : refus de démarrer (comme le WebSocket)")
  void listeVide_echecAuDemarrage() {
    assertThatThrownBy(() -> new OriginCheckFilter(" , "))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  @DisplayName("méthode en minuscules : traitée comme la même méthode")
  void methodeEnMinuscules() throws Exception {
    assertThat(run("post", "https://evil.example", null).passed()).isFalse();
    assertThat(run("get", "https://evil.example", null).passed()).isTrue();
  }
}
