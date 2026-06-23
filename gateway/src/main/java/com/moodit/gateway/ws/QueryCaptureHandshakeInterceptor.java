// Capture la query string du handshake (notamment ?token=...) pour la retransmettre
// telle quelle à core-service lors de l'ouverture de la connexion aval.

package com.moodit.gateway.ws;

import java.util.Map;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Component
public class QueryCaptureHandshakeInterceptor implements HandshakeInterceptor {

  /** Clé sous laquelle la query string brute est rangée dans les attributs de session. */
  public static final String QUERY_ATTR = "rawQuery";

  @Override
  public boolean beforeHandshake(
      ServerHttpRequest request,
      ServerHttpResponse response,
      WebSocketHandler wsHandler,
      Map<String, Object> attributes) {
    attributes.put(QUERY_ATTR, request.getURI().getRawQuery());
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
}
