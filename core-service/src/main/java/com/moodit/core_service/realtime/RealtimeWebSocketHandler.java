// Handler du WebSocket temps réel. UNE seule connexion par client sert tous les
// scopes (chat, forum, cours, programmes), via plusieurs « rooms ».
//
// Protocole entrant (envoyé par le front, voir appSocket.ts) :
//   { "type": "join"|"leave", "scope": "channel"|"forum"|"program"|"user"|"mcp", "id": <number> }
//
// Protocole sortant : les évènements `ServerEvent` (voir RealtimeEventPublisher),
// poussés par les contrôleurs REST quand une donnée change.

package com.moodit.core_service.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Set;

import org.jspecify.annotations.NonNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class RealtimeWebSocketHandler extends TextWebSocketHandler {

  private static final Logger log = LoggerFactory.getLogger(RealtimeWebSocketHandler.class);

  /** Scopes acceptés dans une commande `join` / `leave`. */
  private static final Set<String> ALLOWED_SCOPES =
      Set.of("channel", "forum", "program", "user", "mcp", "establishment");

  /** Limites du décorateur concurrent : délai d'envoi (ms) et tampon (octets). */
  private static final int SEND_TIME_LIMIT_MS = 10_000;
  private static final int BUFFER_SIZE_LIMIT = 512 * 1024;

  private final SubscriptionRegistry registry;
  private final ObjectMapper objectMapper;
  private final RoomAuthorizer authorizer;

  public RealtimeWebSocketHandler(
      SubscriptionRegistry registry, ObjectMapper objectMapper, RoomAuthorizer authorizer) {
    this.registry = registry;
    this.objectMapper = objectMapper;
    this.authorizer = authorizer;
  }

  @Override
  public void afterConnectionEstablished(@NonNull WebSocketSession session) {
    // On enveloppe la session : Spring interdit les envois concurrents sur une
    // session brute, or une room peut être diffusée depuis plusieurs threads.
    WebSocketSession concurrent =
        new ConcurrentWebSocketSessionDecorator(session, SEND_TIME_LIMIT_MS, BUFFER_SIZE_LIMIT);
    registry.bindDecorated(session, concurrent);
    log.debug("WS connecté : session {} (user {})", session.getId(), email(session));
  }

  @Override
  protected void handleTextMessage(@NonNull WebSocketSession session, @NonNull TextMessage message) {
    JsonNode node;
    try {
      node = objectMapper.readTree(message.getPayload());
    } catch (Exception e) {
      log.debug("WS : message JSON invalide ignoré ({})", session.getId());
      return;
    }

    String type = node.path("type").asText(null);
    String scope = node.path("scope").asText(null);
    JsonNode idNode = node.path("id");

    if (type == null || scope == null || !idNode.canConvertToLong()) {
      return;
    }
    if (!ALLOWED_SCOPES.contains(scope)) {
      return;
    }
    long id = idNode.asLong();
    WebSocketSession target = registry.decorated(session);

    switch (type) {
      case "join" -> {
        if (authorizer.canJoin(email(session), scope, id)) {
          registry.join(scope, id, target);
        } else {
          log.debug("WS join REFUSÉ : {} sur {}:{}", email(session), scope, id);
          // (option) notifier le client par une trame d'erreur dédiée.
        }
      }
      // Le `leave` reste toujours autorisé (se désabonner n'expose rien).
      case "leave" -> registry.leave(scope, id, target);
      default -> log.debug("WS : type de commande inconnu '{}' ignoré", type);
    }
  }

  @Override
  public void afterConnectionClosed(@NonNull WebSocketSession session, @NonNull CloseStatus status) {
    registry.removeSession(registry.decorated(session));
    registry.unbindDecorated(session);
    log.debug("WS déconnecté : session {} ({})", session.getId(), status);
  }

  private static String email(WebSocketSession session) {
    Object email = session.getAttributes().get(JwtHandshakeInterceptor.USER_EMAIL_ATTRIBUTE);
    return email != null ? email.toString() : "?";
  }
}
