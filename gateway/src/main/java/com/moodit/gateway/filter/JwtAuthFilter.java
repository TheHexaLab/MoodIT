package com.moodit.gateway.filter;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
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

@Component
public class JwtAuthFilter extends OncePerRequestFilter {

  @Value("${app.jwt.secret}")
  private String jwtSecret;

  @Value("${app.public.routes}")
  private String publicRoutesConfig;

  @Value("${app.auth-service.url}")
  private String authServiceUrl;

  private final RestClient restClient = RestClient.create();

  private List<String> getPublicRoutes() {
    return List.of(publicRoutesConfig.split(","));
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {

    String path = request.getRequestURI();

    // Laisser passer les routes publiques
    for (String publicRoute : getPublicRoutes()) {
      if (path.equals(publicRoute.trim()) || path.startsWith(publicRoute.trim() + "/")) {
        filterChain.doFilter(request, response);
        return;
      }
    }

    // Vérifier le header Authorization
    String authHeader = request.getHeader("Authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
      response.getWriter().write("Token manquant");
      return;
    }

    // 1) Validation locale rapide : signature + expiration (rejette les tokens grossiers
    //    sans solliciter l'auth-service).
    String token = authHeader.substring(7);
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
              .header("Authorization", authHeader)
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

    // Ajouter l'email dans le header pour les services en aval
    request = new WrappedRequest(request, claims.getSubject());
    filterChain.doFilter(request, response);
  }

  private SecretKey getSigningKey() {
    return Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
  }
}
