// Enregistre le proxy WebSocket sur /ws (point d'entrée unique du gateway). Origines
// permissives ici : le client est déjà passé par le front ; l'authentification forte
// (JWT) est faite par core-service au handshake aval.

package com.moodit.gateway.ws;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketProxyConfig implements WebSocketConfigurer {

  private final WebSocketProxyHandler proxyHandler;
  private final QueryCaptureHandshakeInterceptor queryCaptureInterceptor;

  public WebSocketProxyConfig(
      WebSocketProxyHandler proxyHandler,
      QueryCaptureHandshakeInterceptor queryCaptureInterceptor) {
    this.proxyHandler = proxyHandler;
    this.queryCaptureInterceptor = queryCaptureInterceptor;
  }

  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry
        .addHandler(proxyHandler, "/ws")
        .addInterceptors(queryCaptureInterceptor)
        .setAllowedOriginPatterns("*");
  }
}
