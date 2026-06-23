// Enregistre le endpoint WebSocket natif (pas STOMP/SockJS : le front utilise un
// `WebSocket` natif avec un protocole JSON maison). L'authentification se fait à
// l'upgrade via JwtHandshakeInterceptor.
//
// CORS WebSocket : on autorise l'origine du front (allowed-origins). À adapter si
// la connexion passe par le gateway.

package com.moodit.core_service.realtime;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

  private final RealtimeWebSocketHandler handler;
  private final JwtHandshakeInterceptor handshakeInterceptor;

  @Value("${app.cors.allowed-origins}")
  private String allowedOrigins;

  public WebSocketConfig(
      RealtimeWebSocketHandler handler, JwtHandshakeInterceptor handshakeInterceptor) {
    this.handler = handler;
    this.handshakeInterceptor = handshakeInterceptor;
  }

  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry
        .addHandler(handler, "/ws")
        .addInterceptors(handshakeInterceptor)
        .setAllowedOrigins(allowedOrigins.split(","));
  }
}
