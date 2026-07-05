// Filtre d'authentification : laisse passer les routes publiques, sinon valide le JWT
// (signature locale + /auth/validate) et injecte X-User-Email pour les services en aval ; fail-closed.

package com.moodit.gateway.filter;

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
import java.io.IOException;
import java.nio.charset.StandardCharsets;
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

  private final RestClient restClient = RestClient.create();

  // Nom du cookie porteur du JWT (aligné avec auth-service AuthCookie.NAME).
  private static final String TOKEN_COOKIE = "moodit_token";

  // Taille max d'un body mis en cache pour transmission au permission-service (garde-fou
  // memoire : on ne bufferise pas un payload geant).
  private static final long MAX_CACHED_BODY = 1024 * 1024; // 1 Mo

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

    // Chemin protégé : on met le body en cache si c'est une écriture JSON, pour pouvoir
    // le transmettre au permission-service ET que core puisse le relire intact.
    HttpServletRequest base = shouldCacheBody(request) ? new CachedBodyRequest(request) : request;

    // Empêche un client d'injecter lui-même l'identité : on neutralise tout X-User-Email entrant.
    HttpServletRequest sanitized = new StrippedHeaderRequest(base, "X-User-Email");

    // Récupérer le token : cookie moodit_token d'abord (nouveau mécanisme), à défaut le
    // header Authorization: Bearer (ancien mécanisme — retiré à la fin de la bascule).
    String token = extractToken(sanitized);
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

    // 3) Autorisation : le permission-service décide si ce user a le droit d'accéder à
    //    cette route (rôles + appartenance). L'identité vient du JWT, pas du client. Pour
    //    les routes dont l'id de ressource est dans le body, on transmet le body (en cache).
    String requestBody = (base instanceof CachedBodyRequest cached) ? cached.getBodyAsString() : "";
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
                      "body", requestBody))
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

  // Faut-il mettre le body en cache ? Seulement les écritures JSON de taille raisonnable
  // (pas de GET/DELETE, pas de multipart/upload, pas de payload géant).
  private boolean shouldCacheBody(HttpServletRequest request) {
    String method = request.getMethod();
    if (!"POST".equals(method) && !"PUT".equals(method) && !"PATCH".equals(method)) {
      return false;
    }
    String contentType = request.getContentType();
    if (contentType == null || !contentType.toLowerCase().startsWith("application/json")) {
      return false;
    }
    return request.getContentLengthLong() <= MAX_CACHED_BODY;
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
