// Handshake WebSocket du gateway : point d'authentification unique du temps réel.
//   - Récupère le token : cookie moodit_token d'abord ; à défaut la query ?token=,
//     mais uniquement si allowLegacyToken (dev). En prod : cookie-only.
//   - Validation FORTE via /auth/validate : confirme que le token est encore ACTIF en BD
//     (révocation / session unique). Le check WS de core ne fait que la signature ; cette
//     couche comble ce manque au point d'entrée unique.
//   - Le contrôle d'Origin (anti-CSWSH) est fait en amont par WebSocketProxyConfig
//     (setAllowedOrigins). Le token validé est rangé dans les attributs de session pour
//     être réinjecté vers core par WebSocketProxyHandler.

package com.moodit.gateway.ws;

import jakarta.servlet.http.Cookie;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;

@Component
public class AuthHandshakeInterceptor implements HandshakeInterceptor {

  /** Clé sous laquelle le token validé est rangé dans les attributs de session. */
  public static final String TOKEN_ATTR = "authToken";

  /** Cookie porteur du JWT (aligné avec auth-service AuthCookie.NAME et JwtAuthFilter). */
  private static final String TOKEN_COOKIE = "moodit_token";

  @Value("${app.auth-service.url}")
  private String authServiceUrl;

  // Tolérance d'un token hors cookie (ici : query ?token=). true en dev, false en prod
  // (cookie-only). Même propriété que le filtre REST : un seul interrupteur legacy.
  @Value("${app.auth.allow-legacy-token:true}")
  private boolean allowLegacyToken;

  private final RestClient restClient = RestClient.create();

  @Override
  public boolean beforeHandshake(
      ServerHttpRequest request,
      ServerHttpResponse response,
      WebSocketHandler wsHandler,
      Map<String, Object> attributes) {

    String token = extractToken(request);
    if (token == null || token.isBlank()) {
      response.setStatusCode(HttpStatus.UNAUTHORIZED);
      return false;
    }

    // Validation forte : token encore actif en BD (révocation / session unique), que le
    // check WS de core (signature seule) ne voit pas. Fail-closed si auth-service injoignable.
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
      response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
      return false;
    }

    if (!Boolean.TRUE.equals(active)) {
      response.setStatusCode(HttpStatus.UNAUTHORIZED);
      return false;
    }

    attributes.put(TOKEN_ATTR, token);
    return true;
  }

  @Override
  public void afterHandshake(
      ServerHttpRequest request,
      ServerHttpResponse response,
      WebSocketHandler wsHandler,
      Exception exception) {
    // Rien à faire après l'upgrade.
  }

  // Token : cookie moodit_token d'abord ; à défaut query ?token=, uniquement si
  // allowLegacyToken (dev). En prod, seul le cookie est retenu.
  private String extractToken(ServerHttpRequest request) {
    if (request instanceof ServletServerHttpRequest servletRequest) {
      Cookie[] cookies = servletRequest.getServletRequest().getCookies();
      if (cookies != null) {
        for (Cookie cookie : cookies) {
          if (TOKEN_COOKIE.equals(cookie.getName())
              && cookie.getValue() != null
              && !cookie.getValue().isBlank()) {
            return cookie.getValue();
          }
        }
      }
    }
    if (allowLegacyToken) {
      return UriComponentsBuilder.fromUri(request.getURI())
          .build()
          .getQueryParams()
          .getFirst("token");
    }
    return null;
  }
}
