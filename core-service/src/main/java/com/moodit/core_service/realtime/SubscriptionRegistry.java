// Registre des abonnements temps réel : associe chaque « room » (scope:id) à
// l'ensemble des sessions WebSocket qui y sont abonnées. Une room correspond à un
// canal, un forum, un programme ou un utilisateur (les 4 scopes envoyés par le
// front via `join` / `leave`). Thread-safe : les diffusions et les (dés)abonnements
// peuvent arriver de threads différents.

package com.moodit.core_service.realtime;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

@Component
public class SubscriptionRegistry {

  private static final Logger log = LoggerFactory.getLogger(SubscriptionRegistry.class);

  /** room (ex. "channel:5") → sessions abonnées (sessions décorées « concurrent »). */
  private final Map<String, Set<WebSocketSession>> rooms = new ConcurrentHashMap<>();

  /** session brute (id) → session décorée, pour retrouver la même instance partout. */
  private final Map<String, WebSocketSession> decorated = new ConcurrentHashMap<>();

  /** Construit la clé canonique d'une room à partir du scope et de l'id. */
  public static String key(String scope, long id) {
    return scope + ":" + id;
  }

  /** Mémorise la session décorée associée à la session brute (à la connexion). */
  public void bindDecorated(WebSocketSession raw, WebSocketSession decoratedSession) {
    decorated.put(raw.getId(), decoratedSession);
  }

  /** Renvoie la session décorée associée (ou la session elle-même en repli). */
  public WebSocketSession decorated(WebSocketSession raw) {
    return decorated.getOrDefault(raw.getId(), raw);
  }

  /** Oublie la session décorée (à la déconnexion). */
  public void unbindDecorated(WebSocketSession raw) {
    decorated.remove(raw.getId());
  }

  public void join(String scope, long id, WebSocketSession session) {
    rooms.computeIfAbsent(key(scope, id), k -> ConcurrentHashMap.newKeySet()).add(session);
  }

  public void leave(String scope, long id, WebSocketSession session) {
    Set<WebSocketSession> sessions = rooms.get(key(scope, id));
    if (sessions != null) {
      sessions.remove(session);
      if (sessions.isEmpty()) {
        rooms.remove(key(scope, id), sessions); // purge atomique si toujours vide
      }
    }
  }

  /** Retire une session de toutes ses rooms (à la déconnexion). */
  public void removeSession(WebSocketSession session) {
    rooms.forEach((room, sessions) -> sessions.remove(session));
    rooms.entrySet().removeIf(entry -> entry.getValue().isEmpty());
  }

  /** Diffuse une charge JSON déjà sérialisée à toutes les sessions d'une room. */
  public void broadcast(String scope, long id, String payload) {
    Set<WebSocketSession> sessions = rooms.get(key(scope, id));
    if (sessions == null || sessions.isEmpty()) {
      return;
    }
    TextMessage message = new TextMessage(payload);
    for (WebSocketSession session : sessions) {
      if (!session.isOpen()) {
        continue;
      }
      try {
        // La session est déjà un ConcurrentWebSocketSessionDecorator (voir le
        // handler) : les envois concurrents sont sérialisés en interne.
        session.sendMessage(message);
      } catch (IOException e) {
        log.warn("Échec d'envoi vers la session {} (room {})", session.getId(), key(scope, id), e);
      }
    }
  }

  /**
   * Diffuse à TOUTES les sessions abonnées (toutes rooms confondues, dédupliquées) : pour les
   * évènements GLOBAUX comme la mise à jour de profil — l'auteur peut apparaître dans
   * n'importe quel canal / forum, on ne peut donc pas cibler une room précise.
   */
  public void broadcastAll(String payload) {
    TextMessage message = new TextMessage(payload);
    Set<WebSocketSession> seen = ConcurrentHashMap.newKeySet();
    for (Set<WebSocketSession> sessions : rooms.values()) {
      for (WebSocketSession session : sessions) {
        if (!seen.add(session) || !session.isOpen()) {
          continue;
        }
        try {
          session.sendMessage(message);
        } catch (IOException e) {
          log.warn("Échec d'envoi (broadcastAll) vers la session {}", session.getId(), e);
        }
      }
    }
  }
}
