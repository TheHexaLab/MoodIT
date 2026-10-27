package com.moodit.gateway.filter;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * Enveloppes de requête du filtre JWT : ce sont elles qui garantissent que l'identité vue par
 * les services en aval (X-User-Email) vient du JWT et jamais du client, et que le body lu pour
 * le permission-service reste relisable par core.
 */
class RequestWrappersTest {

  private static MockHttpServletRequest requestWithHeaders() {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/courses");
    req.addHeader("Accept", "application/json");
    req.addHeader("X-Trace", "a");
    req.addHeader("X-Trace", "b");
    req.addHeader("x-user-email", "forge@usherbrooke.ca"); // casse différente : doit être vu
    return req;
  }

  // ------------------------------------------------------------------ WrappedRequest

  @Test
  void wrapped_autresHeaders_transmisTelsQuels() {
    WrappedRequest wrapped = new WrappedRequest(requestWithHeaders(), "jwt@usherbrooke.ca");

    assertThat(wrapped.getHeader("Accept")).isEqualTo("application/json");
    assertThat(Collections.list(wrapped.getHeaders("X-Trace"))).containsExactly("a", "b");
  }

  @Test
  void wrapped_emailInsensibleALaCasse_vientDuJwt() {
    WrappedRequest wrapped = new WrappedRequest(requestWithHeaders(), "jwt@usherbrooke.ca");

    assertThat(wrapped.getHeader("X-USER-EMAIL")).isEqualTo("jwt@usherbrooke.ca");
    assertThat(Collections.list(wrapped.getHeaders("x-user-email")))
        .containsExactly("jwt@usherbrooke.ca");
  }

  @Test
  void wrapped_listeDesNoms_contientUneSeuleFoisXUserEmail() {
    WrappedRequest wrapped = new WrappedRequest(requestWithHeaders(), "jwt@usherbrooke.ca");

    // Le nom client (casse différente) est retiré, remplacé par le nom canonique, une seule fois :
    // un proxy qui itère sur les noms ne doit pas recopier la valeur forgée.
    assertThat(Collections.list(wrapped.getHeaderNames()))
        .filteredOn(n -> n.equalsIgnoreCase("X-User-Email"))
        .containsExactly("X-User-Email");
    assertThat(Collections.list(wrapped.getHeaderNames())).contains("Accept", "X-Trace");
  }

  @Test
  void wrapped_sansHeaderClient_ajouteQuandMemeXUserEmail() {
    WrappedRequest wrapped =
        new WrappedRequest(new MockHttpServletRequest("GET", "/x"), "jwt@usherbrooke.ca");

    assertThat(Collections.list(wrapped.getHeaderNames())).containsExactly("X-User-Email");
  }

  // ------------------------------------------------------------------ StrippedHeaderRequest

  @Test
  void stripped_headerMasqueQuelleQueSoitLaCasse() {
    StrippedHeaderRequest stripped =
        new StrippedHeaderRequest(requestWithHeaders(), "X-User-Email");

    assertThat(stripped.getHeader("X-User-Email")).isNull();
    assertThat(stripped.getHeaders("X-USER-EMAIL").hasMoreElements()).isFalse();
    assertThat(Collections.list(stripped.getHeaderNames()))
        .noneMatch(n -> n.equalsIgnoreCase("X-User-Email"));
  }

  @Test
  void stripped_autresHeaders_transmisTelsQuels() {
    StrippedHeaderRequest stripped =
        new StrippedHeaderRequest(requestWithHeaders(), "X-User-Email");

    assertThat(stripped.getHeader("Accept")).isEqualTo("application/json");
    assertThat(Collections.list(stripped.getHeaders("X-Trace"))).containsExactly("a", "b");
    assertThat(Collections.list(stripped.getHeaderNames())).contains("Accept", "X-Trace");
  }

  // ------------------------------------------------------------------ CachedBodyRequest

  private static MockHttpServletRequest jsonRequest(byte[] body, String encoding) {
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/forums/posts");
    req.setContentType("application/json");
    if (encoding != null) {
      req.setCharacterEncoding(encoding);
    }
    req.setContent(body);
    return req;
  }

  @Test
  void cached_bodyRelisablePlusieursFois() throws Exception {
    byte[] json = "{\"a\":1}".getBytes(StandardCharsets.UTF_8);
    CachedBodyRequest cached = (CachedBodyRequest) CachedBodyRequest.read(jsonRequest(json, null), 1024);

    assertThat(cached.getInputStream().readAllBytes()).isEqualTo(json);
    assertThat(cached.getInputStream().readAllBytes()).isEqualTo(json);
    assertThat(cached.getBodyAsString()).isEqualTo("{\"a\":1}");
  }

  @Test
  void cached_flux_finiEtPretSelonLaLecture() throws Exception {
    CachedBodyRequest cached =
        (CachedBodyRequest) CachedBodyRequest.read(jsonRequest(new byte[] {'x'}, null), 1024);
    ServletInputStream in = cached.getInputStream();

    assertThat(in.isReady()).isTrue();
    assertThat(in.isFinished()).isFalse();
    assertThat(in.read()).isEqualTo('x');
    assertThat(in.isFinished()).isTrue();
    assertThat(in.read()).isEqualTo(-1);
    in.setReadListener(null); // lecture synchrone seulement : sans effet sur le flux
    assertThat(in.isFinished()).isTrue();
  }

  @Test
  void cached_lecteur_respecteLEncodageDeLaRequete() throws Exception {
    String text = "{\"titre\":\"élève\"}";
    CachedBodyRequest cached =
        (CachedBodyRequest)
            CachedBodyRequest.read(
                jsonRequest(text.getBytes(StandardCharsets.ISO_8859_1), "ISO-8859-1"), 1024);

    try (BufferedReader reader = cached.getReader()) {
      assertThat(reader.readLine()).isEqualTo(text);
    }
    assertThat(cached.getBodyAsString()).isEqualTo(text);
  }

  @Test
  void cached_sansEncodage_decodeEnUtf8() throws Exception {
    String text = "{\"titre\":\"élève\"}";
    MockHttpServletRequest req = jsonRequest(text.getBytes(StandardCharsets.UTF_8), null);
    req.setCharacterEncoding((String) null);
    assertThat(req.getCharacterEncoding()).isNull(); // précondition : aucun encodage déclaré
    CachedBodyRequest cached = (CachedBodyRequest) CachedBodyRequest.read(req, 1024);

    assertThat(cached.getBodyAsString()).isEqualTo(text);
    try (BufferedReader reader = cached.getReader()) {
      assertThat(reader.readLine()).isEqualTo(text);
    }
  }

  @Test
  void read_corpsALaBorne_misEnCache() throws Exception {
    byte[] body = "abcd".getBytes(StandardCharsets.UTF_8);

    HttpServletRequest read = CachedBodyRequest.read(jsonRequest(body, null), 4);

    assertThat(read).isInstanceOf(CachedBodyRequest.class);
    assertThat(((CachedBodyRequest) read).getBodyAsString()).isEqualTo("abcd");
  }

  // Corps au-delà de la borne (#31) : rien n'est gardé en cache, mais le service en aval reçoit
  // le corps INTACT (octets déjà lus, puis le reste du flux d'origine).
  @Test
  void read_corpsTropGros_rejoueSansCache() throws Exception {
    byte[] body = "abcdefgh".getBytes(StandardCharsets.UTF_8);

    HttpServletRequest read = CachedBodyRequest.read(jsonRequest(body, null), 4);

    assertThat(read).isNotInstanceOf(CachedBodyRequest.class);
    ServletInputStream in = read.getInputStream();
    assertThat(in.isReady()).isTrue();
    assertThat(in.isFinished()).isFalse();
    assertThat(in.read()).isEqualTo('a');
    byte[] rest = new byte[16];
    assertThat(in.read(rest, 0, rest.length)).isEqualTo(4); // fin des octets déjà lus
    assertThat(new String(rest, 0, 4, StandardCharsets.UTF_8)).isEqualTo("bcde");
    assertThat(in.isFinished()).isFalse();
    assertThat(new String(in.readAllBytes(), StandardCharsets.UTF_8)).isEqualTo("fgh");
    assertThat(in.read()).isEqualTo(-1);
    assertThat(in.isFinished()).isTrue();
  }

  @Test
  void read_corpsTropGros_lecteurRespecteLEncodage() throws Exception {
    String text = "{\"titre\":\"élève\"}";

    HttpServletRequest read =
        CachedBodyRequest.read(jsonRequest(text.getBytes(StandardCharsets.ISO_8859_1), "ISO-8859-1"), 4);

    try (BufferedReader reader = read.getReader()) {
      assertThat(reader.readLine()).isEqualTo(text);
    }
  }

  // Un octet nul n'est pas la fin du flux, une lecture de longueur nulle non plus : seul -1 l'est.
  @Test
  void read_corpsTropGros_octetNulEtLectureVide_neTerminentPasLeFlux() throws Exception {
    byte[] body = {0, 0, 0, 0, 0, 1};

    ServletInputStream in = CachedBodyRequest.read(jsonRequest(body, null), 4).getInputStream();

    assertThat(in.read()).isZero();
    assertThat(in.isFinished()).isFalse();
    assertThat(in.read(new byte[4], 0, 0)).isZero();
    assertThat(in.isFinished()).isFalse();
  }
}
