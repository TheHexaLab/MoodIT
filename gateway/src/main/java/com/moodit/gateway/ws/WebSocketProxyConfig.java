// Enregistre le proxy WebSocket sur /ws (point d'entrée unique du gateway).
// L'authentification (token) + la validation forte sont faites par AuthHandshakeInterceptor ;
// le contrôle d'Origin (anti-CSWSH) est fait ici via setAllowedOrigins : seul le front
// autorisé (app.cors.allowed-origins) peut ouvrir le WebSocket, sinon un site tiers pourrait
// ouvrir une connexion en s'appuyant sur le cookie envoyé automatiquement par le navigateur.

package com.moodit.gateway.ws;

import java.util.Arrays;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketProxyConfig implements WebSocketConfigurer {

  private final WebSocketProxyHandler proxyHandler;
  private final AuthHandshakeInterceptor authHandshakeInterceptor;

  @Value("${app.cors.allowed-origins}")
  private String allowedOrigins;

  public WebSocketProxyConfig(
      WebSocketProxyHandler proxyHandler, AuthHandshakeInterceptor authHandshakeInterceptor) {
    this.proxyHandler = proxyHandler;
    this.authHandshakeInterceptor = authHandshakeInterceptor;
  }

  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry
        .addHandler(proxyHandler, "/ws")
        .addInterceptors(authHandshakeInterceptor)
        .setAllowedOrigins(parseAllowedOrigins(allowedOrigins));
  }

  // Origines autorisées (anti-CSWSH) : trim de chaque entrée + filtre des vides (une liste
  // "a, b" ne doit pas produire une origine " b" qui ne matcherait jamais). FAIL-FAST si le
  // résultat est VIDE (FRONT_ORIGIN manquant ou blanc) : setAllowedOrigins([]) DÉSACTIVERAIT
  // le contrôle d'Origin (allow-all → CSWSH). On refuse de démarrer plutôt que d'ouvrir le WS.
  static String[] parseAllowedOrigins(String raw) {
    String[] origins =
        Arrays.stream(raw == null ? new String[0] : raw.split(","))
            .map(String::trim)
            .filter(s -> !s.isEmpty())
            .toArray(String[]::new);
    if (origins.length == 0) {
      throw new IllegalStateException(
          "app.cors.allowed-origins est vide (FRONT_ORIGIN manquant ou blanc) : aucune origine "
              + "WebSocket autorisée. Refus de démarrer (sinon le contrôle d'Origin serait désactivé).");
    }
    return origins;
  }
}
