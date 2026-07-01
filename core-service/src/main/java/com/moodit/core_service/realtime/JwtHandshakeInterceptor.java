// Authentifie l'ouverture du WebSocket. Le client natif se connecte sur
//   /ws?token=<JWT>
// (voir frontend/src/services/appSocket.ts). On valide le token AVANT l'upgrade :
// handshake refusé (401) si absent / invalide. L'email est stocké dans les
// attributs de session pour les logs et l'autorisation des rooms.

package com.moodit.core_service.realtime;

import java.util.Map;

import org.jspecify.annotations.NonNull;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;

@Component
public class JwtHandshakeInterceptor implements HandshakeInterceptor {

  /** Clé sous laquelle l'email authentifié est rangé dans les attributs de session. */
  public static final String USER_EMAIL_ATTRIBUTE = "userEmail";

  private final WsJwtValidator jwtValidator;

  public JwtHandshakeInterceptor(WsJwtValidator jwtValidator) {
    this.jwtValidator = jwtValidator;
  }

  @Override
  public boolean beforeHandshake(
          @NonNull ServerHttpRequest request,
          @NonNull ServerHttpResponse response,
          @NonNull WebSocketHandler wsHandler,
          @NonNull Map<String, Object> attributes) {

    String token = extractToken(request);
    String email = jwtValidator.validateAndGetEmail(token);
    if (email == null) {
      response.setStatusCode(HttpStatus.UNAUTHORIZED);
      return false; // upgrade refusé
    }
    attributes.put(USER_EMAIL_ATTRIBUTE, email);
    return true;
  }

  @Override
  public void afterHandshake(
          @NonNull ServerHttpRequest request,
          @NonNull ServerHttpResponse response,
          @NonNull WebSocketHandler wsHandler,
          Exception exception) {
    // Rien à faire après l'upgrade.
  }

  /** Récupère le token : query param `token`, à défaut header Authorization Bearer. */
  private String extractToken(ServerHttpRequest request) {
    String token =
        UriComponentsBuilder.fromUri(request.getURI())
            .build()
            .getQueryParams()
            .getFirst("token");
    if (token != null && !token.isBlank()) {
      return token;
    }
    if (request instanceof ServletServerHttpRequest servletRequest) {
      String authHeader = servletRequest.getServletRequest().getHeader("Authorization");
      if (authHeader != null && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7);
      }
    }
    return null;
  }
}
