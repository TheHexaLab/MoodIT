// Vérification de l'origine des requêtes qui modifient des données (#234), en défense en profondeur.
//
// La protection CSRF de Spring Security est désactivée dans tous les services : l'authentification
// passe par un jeton dans un cookie HttpOnly et SameSite=Strict, que le navigateur n'envoie jamais
// depuis un autre site. SameSite ne distingue toutefois pas les sous-domaines d'un même site : ce
// filtre refuse en plus toute écriture (POST, PUT, PATCH, DELETE) venue d'une origine qui n'est pas
// le front autorisé (app.cors.allowed-origins, les mêmes origines que le WebSocket).
//
// Une requête sans en-tête Origin (outil comme Bruno, appel serveur) passe, sauf si le navigateur
// la déclare venue d'un autre site par Sec-Fetch-Site. Les lectures (GET, HEAD, OPTIONS) ne sont pas
// concernées.

package com.moodit.gateway.filter;

import com.moodit.gateway.ws.WebSocketProxyConfig;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class OriginCheckFilter extends OncePerRequestFilter {

  private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS", "TRACE");

  /** Valeurs de Sec-Fetch-Site d'une requête lancée depuis une AUTRE origine que la page. */
  private static final Set<String> FOREIGN_FETCH_SITES = Set.of("cross-site", "same-site");

  private final Set<String> allowedOrigins;

  public OriginCheckFilter(@Value("${app.cors.allowed-origins}") String allowedOrigins) {
    // Même liste et même échec au démarrage (liste vide) que le WebSocket.
    this.allowedOrigins =
        Arrays.stream(WebSocketProxyConfig.parseAllowedOrigins(allowedOrigins))
            .map(OriginCheckFilter::normalize)
            .collect(Collectors.toUnmodifiableSet());
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
    if (SAFE_METHODS.contains(request.getMethod().toUpperCase(Locale.ROOT))
        || isAllowed(request)) {
      filterChain.doFilter(request, response);
      return;
    }
    response.setStatus(HttpServletResponse.SC_FORBIDDEN);
    response.getWriter().write("Origine refusée");
  }

  private boolean isAllowed(HttpServletRequest request) {
    String origin = request.getHeader("Origin");
    if (origin != null) return allowedOrigins.contains(normalize(origin));
    String fetchSite = request.getHeader("Sec-Fetch-Site");
    return fetchSite == null || !FOREIGN_FETCH_SITES.contains(fetchSite.toLowerCase(Locale.ROOT));
  }

  /** Origine comparable : sans barre oblique finale ni différence de casse. */
  private static String normalize(String origin) {
    String trimmed = origin.trim();
    if (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
    return trimmed.toLowerCase(Locale.ROOT);
  }
}
