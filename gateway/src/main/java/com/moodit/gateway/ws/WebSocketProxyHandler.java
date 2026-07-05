// Proxy WebSocket du gateway : pour chaque client navigateur connecté sur /ws, on ouvre
// une connexion AVAL vers core-service et on relaie les trames dans les deux sens. Le
// token (validé par AuthHandshakeInterceptor) est réinjecté vers core en header
// Authorization — et non plus en query — pour ne pas exposer le JWT dans les logs/URLs.
// Le gateway est le point d'entrée et d'authentification unique ; core revalide la
// signature à son propre handshake (défense en profondeur).

package com.moodit.gateway.ws;

import java.net.URI;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

@Component
public class WebSocketProxyHandler extends AbstractWebSocketHandler {

  private static final Logger log = LoggerFactory.getLogger(WebSocketProxyHandler.class);

  private static final int SEND_TIME_LIMIT_MS = 10_000;
  private static final int BUFFER_SIZE_LIMIT = 512 * 1024;

  /** URL du endpoint WebSocket de core-service (ex. ws://core:8081/ws). */
  private final String coreWsUrl;

  /** session client (id) → session aval vers core-service. */
  private final Map<String, WebSocketSession> downstreamByClient = new ConcurrentHashMap<>();

  public WebSocketProxyHandler(@Value("${app.core-service.ws-url}") String coreWsUrl) {
    this.coreWsUrl = coreWsUrl;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession clientRaw) throws Exception {
    // Envois concurrents sûrs vers le client (le relais aval écrit depuis son thread).
    WebSocketSession client =
        new ConcurrentWebSocketSessionDecorator(clientRaw, SEND_TIME_LIMIT_MS, BUFFER_SIZE_LIMIT);

    // Token validé au handshake amont : réinjecté vers core en header Authorization.
    String token = (String) clientRaw.getAttributes().get(AuthHandshakeInterceptor.TOKEN_ATTR);
    WebSocketHttpHeaders headers = new WebSocketHttpHeaders();
    if (token != null && !token.isBlank()) {
      headers.add("Authorization", "Bearer " + token);
    }

    try {
      WebSocketSession downstream =
          new StandardWebSocketClient()
              .execute(new DownstreamRelayHandler(client), headers, URI.create(coreWsUrl))
              .get();
      downstreamByClient.put(clientRaw.getId(), downstream);
    } catch (Exception e) {
      // Core indisponible / token refusé au handshake aval : on ferme le client.
      log.warn("Proxy WS : impossible d'ouvrir la connexion aval vers {}", coreWsUrl, e);
      clientRaw.close(CloseStatus.SERVER_ERROR);
    }
  }

  @Override
  protected void handleTextMessage(WebSocketSession clientRaw, TextMessage message)
      throws Exception {
    forward(clientRaw, message);
  }

  @Override
  protected void handleBinaryMessage(WebSocketSession clientRaw, BinaryMessage message)
      throws Exception {
    forward(clientRaw, message);
  }

  private void forward(WebSocketSession clientRaw, org.springframework.web.socket.WebSocketMessage<?> message)
      throws Exception {
    WebSocketSession downstream = downstreamByClient.get(clientRaw.getId());
    if (downstream != null && downstream.isOpen()) {
      downstream.sendMessage(message);
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession clientRaw, CloseStatus status)
      throws Exception {
    WebSocketSession downstream = downstreamByClient.remove(clientRaw.getId());
    if (downstream != null && downstream.isOpen()) {
      downstream.close(status);
    }
  }
}
