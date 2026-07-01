// Vérifie le cycle d'un client : connexion → `join` → réception des diffusions de
// sa room → `leave` → plus de réception. Couvre le parsing des commandes entrantes
// et le routage de bout en bout (handler + registre + publisher).

package com.moodit.core_service.realtime;

import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.realtime.dto.Author;
import com.moodit.core_service.realtime.dto.ChannelMessageDto;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

class RealtimeWebSocketHandlerTest {

  private final ObjectMapper objectMapper = new ObjectMapper();
  private SubscriptionRegistry registry;
  private RealtimeEventPublisher publisher;
  private RealtimeWebSocketHandler handler;

  @BeforeEach
  void setUp() {
    registry = new SubscriptionRegistry();
    publisher = new RealtimeEventPublisher(registry, objectMapper);
    // Autorisation permissive : les tests vérifient le routage, pas les droits.
    handler = new RealtimeWebSocketHandler(registry, objectMapper, (email, scope, id) -> true);
  }

  private WebSocketSession openSession() {
    WebSocketSession session = mock(WebSocketSession.class);
    when(session.getId()).thenReturn("s1");
    lenient().when(session.isOpen()).thenReturn(true);
    lenient().when(session.getAttributes()).thenReturn(new java.util.HashMap<>());
    return session;
  }

  private ChannelMessageDto sampleMessage() {
    return new ChannelMessageDto(
        1, "hi", "2026-06-22T10:00:00.000Z", new Author(2, "rosie1234", "R", "HG"), null, "c1");
  }

  @Test
  void apresJoin_laSessionRecoitLesDiffusionsDeSaRoom() throws Exception {
    WebSocketSession session = openSession();
    handler.afterConnectionEstablished(session);
    handler.handleTextMessage(session, new TextMessage("{\"type\":\"join\",\"scope\":\"channel\",\"id\":5}"));

    publisher.messageCreated(5, sampleMessage());

    // Le handler diffuse via la session décorée, qui délègue à la session brute.
    verify(session, atLeastOnce()).sendMessage(org.mockito.ArgumentMatchers.any(TextMessage.class));
  }

  @Test
  void apresLeave_laSessionNeRecoitPlusRien() throws Exception {
    WebSocketSession session = openSession();
    handler.afterConnectionEstablished(session);
    handler.handleTextMessage(session, new TextMessage("{\"type\":\"join\",\"scope\":\"channel\",\"id\":5}"));
    handler.handleTextMessage(session, new TextMessage("{\"type\":\"leave\",\"scope\":\"channel\",\"id\":5}"));

    publisher.messageCreated(5, sampleMessage());

    verify(session, never()).sendMessage(org.mockito.ArgumentMatchers.any());
  }

  @Test
  void apresDeconnexion_laSessionEstRetireeDeSesRooms() throws Exception {
    WebSocketSession session = openSession();
    handler.afterConnectionEstablished(session);
    handler.handleTextMessage(session, new TextMessage("{\"type\":\"join\",\"scope\":\"channel\",\"id\":5}"));
    handler.afterConnectionClosed(session, CloseStatus.NORMAL);

    publisher.messageCreated(5, sampleMessage());

    verify(session, never()).sendMessage(org.mockito.ArgumentMatchers.any());
  }

  @Test
  void scopeMcp_estAccepteEtRoute() throws Exception {
    WebSocketSession session = openSession();
    handler.afterConnectionEstablished(session);
    handler.handleTextMessage(session, new TextMessage("{\"type\":\"join\",\"scope\":\"mcp\",\"id\":8}"));

    publisher.mcpAnalysisCreated(
        8, new com.moodit.core_service.realtime.dto.McpResponseSummaryDto(1, "2026-06-22T10:00:00.000Z", 3, 2));

    verify(session, atLeastOnce()).sendMessage(org.mockito.ArgumentMatchers.any(TextMessage.class));
  }

  @Test
  void commandeInvalide_estIgnoreeSansErreur() throws Exception {
    WebSocketSession session = openSession();
    handler.afterConnectionEstablished(session);
    // JSON cassé, scope inconnu, id manquant : aucun ne doit lever d'exception.
    handler.handleTextMessage(session, new TextMessage("pas du json"));
    handler.handleTextMessage(session, new TextMessage("{\"type\":\"join\",\"scope\":\"galaxy\",\"id\":5}"));
    handler.handleTextMessage(session, new TextMessage("{\"type\":\"join\",\"scope\":\"channel\"}"));

    publisher.messageCreated(5, sampleMessage());

    verify(session, never()).sendMessage(org.mockito.ArgumentMatchers.any());
  }
}
