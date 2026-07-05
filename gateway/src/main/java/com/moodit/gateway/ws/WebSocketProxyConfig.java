// Enregistre le proxy WebSocket sur /ws (point d'entrée unique du gateway).
// L'authentification (token) + la validation forte sont faites par AuthHandshakeInterceptor ;
// le contrôle d'Origin (anti-CSWSH) est fait ici via setAllowedOrigins : seul le front
// autorisé (app.cors.allowed-origins) peut ouvrir le WebSocket, sinon un site tiers pourrait
// ouvrir une connexion en s'appuyant sur le cookie envoyé automatiquement par le navigateur.

package com.moodit.gateway.ws;

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
        .setAllowedOrigins(allowedOrigins.split(","));
  }
}
