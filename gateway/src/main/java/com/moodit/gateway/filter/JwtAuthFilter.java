// Filtre d'authentification : laisse passer les routes publiques, sinon valide le JWT
// (signature locale + /auth/validate) et injecte X-User-Email pour les services en aval ; fail-closed.

package com.moodit.gateway.filter;

import com.moodit.gateway.config.HttpClients;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.filter.OncePerRequestFilter;

import javax.crypto.SecretKey;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

@Component
public class JwtAuthFilter extends OncePerRequestFilter {

  @Value("${app.jwt.secret}")
  private String jwtSecret;

  @Value("${app.public.routes}")
  private String publicRoutesConfig;

  @Value("${app.auth-service.url}")
  private String authServiceUrl;

  @Value("${app.permission-service.url}")
  private String permissionServiceUrl;

  // Tolérance d'un token hors cookie (ici : header Authorization: Bearer). true en dev
  // (Bruno / tests API), false en prod : le navigateur envoie le cookie, seul un client
  // hors-app présenterait un header -> refusé en prod pour un chemin d'auth unique.
  @Value("${app.auth.allow-legacy-token:true}")
  private boolean allowLegacyToken;

  // Délais explicites (#31) : un auth ou permission bloqué ne doit pas immobiliser le gateway.
  private final RestClient restClient = HttpClients.internal();

  // Nom du cookie porteur du JWT (aligné avec auth-service AuthCookie.NAME).
  private static final String TOKEN_COOKIE = "moodit_token";

  // Taille max d'un body d'écriture JSON (garde-fou mémoire : on ne bufferise pas un payload
  // géant). Au-delà : 413, jamais transmis (#31). Même limite que le nginx du frontend
  // (client_max_body_size par défaut), donc aucune requête légitime n'est perdue.
  private static final int MAX_CACHED_BODY = 1024 * 1024; // 1 Mo

  private List<String> getPublicRoutes() {
    return List.of(publicRoutesConfig.split(","));
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {

    String path = request.getRequestURI();

    // Laisser passer les routes publiques : on neutralise juste un X-User-Email forgé
    // (le body n'est pas lu, son flux reste intact pour le service en aval).
    for (String publicRoute : getPublicRoutes()) {
      if (path.equals(publicRoute.trim()) || path.startsWith(publicRoute.trim() + "/")) {
        filterChain.doFilter(new StrippedHeaderRequest(request, "X-User-Email"), response);
        return;
      }
    }

    // Chemin protégé : seul l'encodage d'un caractère NON ASCII (UTF-8 valide) est accepté, pour
    // un paramètre texte dans le chemin (ex. un nom accentué, #111). Tout caractère ASCII doit
    // être écrit tel quel : un ASCII encodé est lu différemment par le contrôle d'accès et par le
    // service qui l'exécute (/api/audit%2Dlogs). Les littéraux des routes sont en ASCII, donc un
    // caractère non ASCII ne peut correspondre qu'à une variable, des deux côtés. Le
    // permission-service décode aussi de son côté : deux barrières indépendantes.
    if (!hasOnlyNonAsciiEncodings(path)) {
      response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
      response.getWriter().write("Chemin invalide");
      return;
    }

    // Récupérer le token : cookie moodit_token d'abord (nouveau mécanisme), à défaut le
    // header Authorization: Bearer (ancien mécanisme — retiré à la fin de la bascule).
    String token = extractToken(request);
    if (token == null || token.isBlank()) {
      response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
      response.getWriter().write("Token manquant");
      return;
    }

    // 1) Validation locale rapide : signature + expiration (rejette les tokens grossiers
    //    sans solliciter l'auth-service).
    Claims claims;
    try {
      claims =
          Jwts.parser().verifyWith(getSigningKey()).build().parseSignedClaims(token).getPayload();
    } catch (Exception e) {
      response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
      response.getWriter().write("Token invalide");
      return;
    }

    // 2) Validation forte : l'auth-service confirme que ce token est encore le token ACTIF
    //    (hash en BD). Couvre la révocation / session unique, impossible à vérifier ici.
    Boolean active;
    try {
      active =
          restClient
              .post()
              .uri(authServiceUrl + "/auth/validate")
              .header("Authorization", "Bearer " + token)
              .retrieve()
              .body(Boolean.class);
    } catch (Exception e) {
      // Impossible de joindre l'auth-service : on refuse (fail-closed) plutôt que de
      // laisser passer un token potentiellement révoqué.
      response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
      response.getWriter().write("Service d'authentification indisponible");
      return;
    }

    if (!Boolean.TRUE.equals(active)) {
      response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
      response.getWriter().write("Token invalide");
      return;
    }

    // Le body n'est lu qu'une fois l'appelant authentifié (#31). Écriture JSON : mis en cache,
    // lecture bornée à MAX_CACHED_BODY, pour le transmettre au permission-service ET que core
    // puisse le relire intact. Trop gros : refusé, car l'autorisation dépend du body et ne peut
    // pas être décidée sans lui (le Content-Length annoncé est vérifié avant toute lecture, la
    // lecture bornée couvre une requête chunked qui n'en annonce aucun).
    HttpServletRequest base = request;
    if (shouldCacheBody(request)) {
      CachedBodyRequest body =
          request.getContentLengthLong() <= MAX_CACHED_BODY
              ? CachedBodyRequest.read(request, MAX_CACHED_BODY)
              : null;
      if (body == null) {
        response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
        response.getWriter().write("Corps de requête trop volumineux");
        return;
      }
      base = body;
    }

    // Empêche un client d'injecter lui-même l'identité : on neutralise tout X-User-Email entrant.
    HttpServletRequest sanitized = new StrippedHeaderRequest(base, "X-User-Email");

    // 3) Autorisation : le permission-service décide si ce user a le droit d'accéder à
    //    cette route (rôles + appartenance). L'identité vient du JWT, pas du client. Pour
    //    les routes dont l'id de ressource est dans le body, on transmet le body (en cache).
    String requestBody = (base instanceof CachedBodyRequest cached) ? cached.getBodyAsString() : "";
    // Query string brute (?scope=...) : getRequestURI() l'exclut, mais certaines regles en
    // dependent (ex. GET /roles?scope=global|program). On la transmet a part (jamais null).
    String queryString = request.getQueryString() == null ? "" : request.getQueryString();
    boolean allowed;
    try {
      Map<?, ?> body =
          restClient
              .post()
              .uri(permissionServiceUrl + "/permissions/validate")
              .body(
                  Map.of(
                      "email", claims.getSubject(),
                      "path", path,
                      "method", request.getMethod(),
                      "body", requestBody,
                      "query", queryString))
              .retrieve()
              .body(Map.class);
      allowed = body != null && Boolean.TRUE.equals(body.get("allowed"));
    } catch (Exception e) {
      // Impossible de joindre le permission-service : on refuse (fail-closed).
      response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
      response.getWriter().write("Service de permissions indisponible");
      return;
    }

    if (!allowed) {
      response.setStatus(HttpServletResponse.SC_FORBIDDEN);
      response.getWriter().write("Accès refusé");
      return;
    }

    // Ajouter l'email (issu du JWT) dans le header pour les services en aval.
    // On enveloppe `sanitized` pour que toute valeur cliente soit déjà écrasée.
    HttpServletRequest authenticated = new WrappedRequest(sanitized, claims.getSubject());
    filterChain.doFilter(authenticated, response);
  }

  // Vrai si chaque %xx du chemin encode un octet >= 0x80 et si le chemin décodé est de l'UTF-8
  // valide. Un chemin sans '%' passe ; un %xx incomplet, non hexadécimal ou ASCII est refusé.
  static boolean hasOnlyNonAsciiEncodings(String path) {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    for (int i = 0; i < path.length(); i++) {
      char c = path.charAt(i);
      if (c != '%') {
        bytes.write(c); // URI brute : caractères ASCII seulement
        continue;
      }
      if (i + 2 >= path.length()) {
        return false;
      }
      int b;
      try {
        b = HexFormat.fromHexDigits(path, i + 1, i + 3);
      } catch (IllegalArgumentException e) {
        return false; // non hexadécimal
      }
      if (b < 0x80) {
        return false;
      }
      bytes.write(b);
      i += 2;
    }
    try {
      StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes.toByteArray()));
      return true;
    } catch (CharacterCodingException e) {
      return false;
    }
  }

  // Faut-il mettre le body en cache ? Seulement les écritures JSON (pas de GET/DELETE, pas de
  // multipart/upload). La taille est vérifiée par l'appelant (#31).
  private boolean shouldCacheBody(HttpServletRequest request) {
    String method = request.getMethod();
    if (!"POST".equals(method) && !"PUT".equals(method) && !"PATCH".equals(method)) {
      return false;
    }
    String contentType = request.getContentType();
    return contentType != null && contentType.toLowerCase().startsWith("application/json");
  }

  // Extraction du token :
  //   1) cookie moodit_token (HttpOnly) — mécanisme unique en prod ;
  //   2) header Authorization: Bearer — uniquement si allowLegacyToken (dev : Bruno/tests).
  private String extractToken(HttpServletRequest request) {
    Cookie[] cookies = request.getCookies();
    if (cookies != null) {
      for (Cookie cookie : cookies) {
        if (TOKEN_COOKIE.equals(cookie.getName())
            && cookie.getValue() != null
            && !cookie.getValue().isBlank()) {
          return cookie.getValue();
        }
      }
    }
    if (allowLegacyToken) {
      String authHeader = request.getHeader("Authorization");
      if (authHeader != null && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7);
      }
    }
    return null;
  }

  private SecretKey getSigningKey() {
    return Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
  }
}
