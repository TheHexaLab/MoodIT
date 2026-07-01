// Vérifie que les évènements diffusés ont EXACTEMENT la forme attendue par le front
// (frontend/src/services/appSocket.ts → ServerEvent) : noms de champs, snake_case
// des entités, et routage vers la bonne room. Aucun réseau / BD : ObjectMapper réel,
// SubscriptionRegistry réel, sessions WebSocket simulées (Mockito).

package com.moodit.core_service.realtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.realtime.dto.Author;
import com.moodit.core_service.realtime.dto.ChannelMessageDto;
import com.moodit.core_service.realtime.dto.ForumPostDto;
import com.moodit.core_service.realtime.dto.ItemChangeDto;
import com.moodit.core_service.realtime.dto.ItemDto;
import com.moodit.core_service.realtime.dto.McpResponseSummaryDto;
import com.moodit.core_service.realtime.dto.ProgramDto;
import java.io.IOException;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

class RealtimeEventPublisherTest {

  private final ObjectMapper objectMapper = new ObjectMapper();
  private SubscriptionRegistry registry;
  private RealtimeEventPublisher publisher;

  @BeforeEach
  void setUp() {
    registry = new SubscriptionRegistry();
    publisher = new RealtimeEventPublisher(registry, objectMapper);
  }

  /** Session ouverte simulée, abonnée à une room. */
  private WebSocketSession joinedSession(String scope, long id) {
    WebSocketSession session = mock(WebSocketSession.class);
    lenient().when(session.isOpen()).thenReturn(true);
    registry.join(scope, id, session);
    return session;
  }

  /** Récupère le JSON diffusé à une session (1 seul message attendu). */
  private JsonNode capturePayload(WebSocketSession session) throws IOException {
    ArgumentCaptor<TextMessage> captor = ArgumentCaptor.forClass(TextMessage.class);
    verify(session).sendMessage(captor.capture());
    return objectMapper.readTree(captor.getValue().getPayload());
  }

  @Test
  void messageCreated_aLaFormeAttendueEtEnSnakeCase() throws IOException {
    WebSocketSession session = joinedSession("channel", 5);
    ChannelMessageDto message =
        new ChannelMessageDto(
            42,
            "Bonjour",
            "2026-06-22T10:00:00.000Z",
            new Author(2, "rosie1234", "Rosie", "HG", "#0a5cc0"),
            null,
            "client-abc");

    publisher.messageCreated(5, message);

    JsonNode event = capturePayload(session);
    assertThat(event.get("type").asText()).isEqualTo("message:created");
    assertThat(event.get("channelId").asLong()).isEqualTo(5);
    JsonNode msg = event.get("message");
    assertThat(msg.get("id").asLong()).isEqualTo(42);
    assertThat(msg.get("content").asText()).isEqualTo("Bonjour");
    assertThat(msg.get("createdAt").asText()).isEqualTo("2026-06-22T10:00:00.000Z");
    // ⚠ contrat de déduplication optimiste ↔ écho
    assertThat(msg.get("clientMsgId").asText()).isEqualTo("client-abc");
    assertThat(msg.get("author").get("firstName").asText()).isEqualTo("Rosie");
    assertThat(msg.get("author").get("avatarColor").asText()).isEqualTo("#0a5cc0");
  }

  @Test
  void broadcast_neToucheQueLaRoomCiblee() throws IOException {
    WebSocketSession inRoom = joinedSession("channel", 5);
    WebSocketSession otherRoom = joinedSession("channel", 6);

    publisher.messageDeleted(5, 42);

    JsonNode event = capturePayload(inRoom);
    assertThat(event.get("type").asText()).isEqualTo("message:deleted");
    assertThat(event.get("messageId").asLong()).isEqualTo(42);
    verify(otherRoom, never()).sendMessage(org.mockito.ArgumentMatchers.any());
  }

  @Test
  void postCreated_conserveParentIdNullPourUnSujetRacine() throws IOException {
    WebSocketSession session = joinedSession("forum", 9);
    ForumPostDto post =
        new ForumPostDto(
            100,
            "Nouveau sujet",
            "2026-06-22T10:00:00.000Z",
            new Author(2, "rosie1234", "Rosie", "HG"),
            false,
            "Titre",
            List.of(),
            List.of(),
            0,
            "client-post-1");

    publisher.postCreated(9, post, null);

    JsonNode event = capturePayload(session);
    assertThat(event.get("type").asText()).isEqualTo("post:created");
    assertThat(event.get("forumId").asLong()).isEqualTo(9);
    // parentId DOIT être présent et null (le front distingue racine / réponse).
    assertThat(event.has("parentId")).isTrue();
    assertThat(event.get("parentId").isNull()).isTrue();
    assertThat(event.get("post").get("clientPostId").asText()).isEqualTo("client-post-1");
  }

  @Test
  void postVoted_porteUserIdEtValeur() throws IOException {
    WebSocketSession session = joinedSession("forum", 9);

    publisher.postVoted(9, 100, 2, -1);

    JsonNode event = capturePayload(session);
    assertThat(event.get("type").asText()).isEqualTo("post:voted");
    assertThat(event.get("postId").asLong()).isEqualTo(100);
    assertThat(event.get("userId").asLong()).isEqualTo(2);
    assertThat(event.get("value").asInt()).isEqualTo(-1);
  }

  @Test
  void sectionChanged_serialiseLUnionItemChange() throws IOException {
    WebSocketSession session = joinedSession("program", 1);

    publisher.sectionChanged(1, 8, "text", ItemChangeDto.create(new ItemDto("uuid-1", "canal-1")));

    JsonNode event = capturePayload(session);
    assertThat(event.get("type").asText()).isEqualTo("section:changed");
    assertThat(event.get("courseId").asLong()).isEqualTo(8);
    assertThat(event.get("sectionType").asText()).isEqualTo("text");
    JsonNode change = event.get("change");
    assertThat(change.get("type").asText()).isEqualTo("create");
    assertThat(change.get("item").get("name").asText()).isEqualTo("canal-1");
    // Les champs des autres variantes (id/name/orderedIds) sont omis.
    assertThat(change.has("orderedIds")).isFalse();
  }

  @Test
  void programDeleted_estRouteVersLaRoomUtilisateur() throws IOException {
    WebSocketSession session = joinedSession("user", 3);

    publisher.programDeleted(3, 7);

    JsonNode event = capturePayload(session);
    assertThat(event.get("type").asText()).isEqualTo("program:deleted");
    assertThat(event.get("userId").asLong()).isEqualTo(3);
    assertThat(event.get("programId").asLong()).isEqualTo(7);
  }

  @Test
  void mcpAnalysisCreated_aLaFormeAttendueEtEstRouteVersLaRoomCours() throws IOException {
    WebSocketSession inRoom = joinedSession("mcp", 8);
    WebSocketSession otherCourse = joinedSession("mcp", 9);

    publisher.mcpAnalysisCreated(8, new McpResponseSummaryDto(42, "2026-06-22T10:00:00.000Z", 3, 2));

    JsonNode event = capturePayload(inRoom);
    assertThat(event.get("type").asText()).isEqualTo("mcp:analysis-created");
    assertThat(event.get("courseId").asLong()).isEqualTo(8);
    JsonNode analysis = event.get("analysis");
    assertThat(analysis.get("id").asLong()).isEqualTo(42);
    assertThat(analysis.get("createdAt").asText()).isEqualTo("2026-06-22T10:00:00.000Z");
    assertThat(analysis.get("strengthsCount").asInt()).isEqualTo(3);
    assertThat(analysis.get("improvementsCount").asInt()).isEqualTo(2);
    // Le résumé ne porte PAS le contenu (le détail se fetch au clic).
    assertThat(analysis.has("content")).isFalse();
    verify(otherCourse, never()).sendMessage(org.mockito.ArgumentMatchers.any());
  }

  @Test
  void mcpAnalysisFailed_porteLeLanceurEtLaRaison() throws IOException {
    WebSocketSession session = joinedSession("mcp", 8);

    publisher.mcpAnalysisFailed(8, 4, "Service MCP indisponible");

    JsonNode event = capturePayload(session);
    assertThat(event.get("type").asText()).isEqualTo("mcp:analysis-failed");
    assertThat(event.get("courseId").asLong()).isEqualTo(8);
    assertThat(event.get("userId").asLong()).isEqualTo(4);
    assertThat(event.get("reason").asText()).isEqualTo("Service MCP indisponible");
  }

  @Test
  void programUpdated_ometCoursesQuandAbsent() throws IOException {
    WebSocketSession session = joinedSession("user", 3);

    publisher.programUpdated(3, new ProgramDto(7, "Génie info", "GIN", "71", "#1a6e3c"));

    JsonNode event = capturePayload(session);
    JsonNode program = event.get("program");
    assertThat(program.get("name").asText()).isEqualTo("Génie info");
    assertThat(program.has("courses")).isFalse(); // NON_NULL : omis si non fourni
  }
}
