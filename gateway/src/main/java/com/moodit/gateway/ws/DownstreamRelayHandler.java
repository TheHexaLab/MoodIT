// Côté AVAL du proxy : reçoit les trames de core-service et les recopie vers le
// client navigateur. Ferme le client si la connexion aval se ferme.

package com.moodit.gateway.ws;

import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

public class DownstreamRelayHandler extends AbstractWebSocketHandler {

  /** Session vers le navigateur (déjà décorée pour des envois concurrents sûrs). */
  private final WebSocketSession clientSession;

  public DownstreamRelayHandler(WebSocketSession clientSession) {
    this.clientSession = clientSession;
  }

  @Override
  protected void handleTextMessage(WebSocketSession downstream, TextMessage message)
      throws Exception {
    if (clientSession.isOpen()) {
      clientSession.sendMessage(message);
    }
  }

  @Override
  protected void handleBinaryMessage(WebSocketSession downstream, BinaryMessage message)
      throws Exception {
    if (clientSession.isOpen()) {
      clientSession.sendMessage(message);
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession downstream, CloseStatus status)
      throws Exception {
    if (clientSession.isOpen()) {
      clientSession.close(status);
    }
  }
}
