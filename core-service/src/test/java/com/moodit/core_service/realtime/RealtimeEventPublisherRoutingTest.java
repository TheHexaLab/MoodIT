// Complète RealtimeEventPublisherTest : forme JSON et room cible de TOUS les autres évènements
// (chat, forum, cours, quiz, tentatives, programmes, rôles, établissements, MCP, profil), ainsi que
// la robustesse en cas d'échec de sérialisation. SubscriptionRegistry réel, sessions simulées.

package com.moodit.core_service.realtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.realtime.dto.Author;
import com.moodit.core_service.realtime.dto.CourseDto;
import com.moodit.core_service.realtime.dto.ProgramDto;
import com.moodit.core_service.realtime.dto.RoleDto;
import java.io.IOException;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

class RealtimeEventPublisherRoutingTest {

  private final ObjectMapper objectMapper = new ObjectMapper();
  private SubscriptionRegistry registry;
  private RealtimeEventPublisher publisher;

  @BeforeEach
  void setUp() {
    registry = new SubscriptionRegistry();
    publisher = new RealtimeEventPublisher(registry, objectMapper);
  }

  private WebSocketSession joinedSession(String scope, long id) {
    WebSocketSession session = mock(WebSocketSession.class);
    lenient().when(session.isOpen()).thenReturn(true);
    registry.join(scope, id, session);
    return session;
  }

  private JsonNode capturePayload(WebSocketSession session) throws IOException {
    ArgumentCaptor<TextMessage> captor = ArgumentCaptor.forClass(TextMessage.class);
    verify(session).sendMessage(captor.capture());
    return objectMapper.readTree(captor.getValue().getPayload());
  }

  // ── Chat / forum ──────────────────────────────────────────────────────────

  @Test
  @DisplayName("message:edited → room channel, porte l'id et le nouveau contenu")
  void messageEdited() throws IOException {
    WebSocketSession s = joinedSession("channel", 5);

    publisher.messageEdited(5, 42, "Corrigé");

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("message:edited");
    assertThat(e.get("channelId").asLong()).isEqualTo(5);
    assertThat(e.get("messageId").asLong()).isEqualTo(42);
    assertThat(e.get("content").asText()).isEqualTo("Corrigé");
  }

  @Test
  @DisplayName("post:edited → room forum, titre null conservé pour une réponse")
  void postEdited() throws IOException {
    WebSocketSession s = joinedSession("forum", 9);

    publisher.postEdited(9, 100, "nouveau", null);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("post:edited");
    assertThat(e.get("postId").asLong()).isEqualTo(100);
    assertThat(e.get("content").asText()).isEqualTo("nouveau");
    assertThat(e.has("title")).isTrue();
    assertThat(e.get("title").isNull()).isTrue();
  }

  @Test
  @DisplayName("post:deleted → room forum")
  void postDeleted() throws IOException {
    WebSocketSession s = joinedSession("forum", 9);

    publisher.postDeleted(9, 100);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("post:deleted");
    assertThat(e.get("forumId").asLong()).isEqualTo(9);
    assertThat(e.get("postId").asLong()).isEqualTo(100);
  }

  // ── Cours (scope program) ────────────────────────────────────────────────

  @Test
  @DisplayName("course:created / course:edited → room program avec le cours sérialisé")
  void courseCreatedEtEdited() throws IOException {
    WebSocketSession s = joinedSession("program", 3);

    publisher.courseCreated(3, CourseDto.of(8, "IFT1", "Algo"));

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("course:created");
    assertThat(e.get("programId").asLong()).isEqualTo(3);
    assertThat(e.get("course").get("code").asText()).isEqualTo("IFT1");
    assertThat(e.get("course").get("channels").isArray()).isTrue();

    WebSocketSession other = joinedSession("program", 4);
    publisher.courseEdited(4, CourseDto.of(8, "IFT1", "Algo II"));
    JsonNode edited = capturePayload(other);
    assertThat(edited.get("type").asText()).isEqualTo("course:edited");
    assertThat(edited.get("course").get("title").asText()).isEqualTo("Algo II");
  }

  @Test
  @DisplayName("course:deleted → room program")
  void courseDeleted() throws IOException {
    WebSocketSession s = joinedSession("program", 3);

    publisher.courseDeleted(3, 8);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("course:deleted");
    assertThat(e.get("courseId").asLong()).isEqualTo(8);
  }

  // ── Quiz ─────────────────────────────────────────────────────────────────

  @Test
  @DisplayName("quiz:created → room program, ids programme/cours/quiz")
  void quizCreated() throws IOException {
    WebSocketSession s = joinedSession("program", 3);

    publisher.quizCreated(3, 8, 77);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("quiz:created");
    assertThat(e.get("programId").asLong()).isEqualTo(3);
    assertThat(e.get("courseId").asLong()).isEqualTo(8);
    assertThat(e.get("quizId").asLong()).isEqualTo(77);
  }

  @Test
  @DisplayName("quiz:updated → room program")
  void quizUpdated() throws IOException {
    WebSocketSession s = joinedSession("program", 3);

    publisher.quizUpdated(3, 8, 77);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("quiz:updated");
    assertThat(e.get("quizId").asLong()).isEqualTo(77);
  }

  @Test
  @DisplayName("quiz:reordered → room program, sans quizId")
  void quizReordered() throws IOException {
    WebSocketSession s = joinedSession("program", 3);

    publisher.quizReordered(3, 8);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("quiz:reordered");
    assertThat(e.get("courseId").asLong()).isEqualTo(8);
    assertThat(e.has("quizId")).isFalse();
  }

  @Test
  @DisplayName("quiz:deleted → room program")
  void quizDeleted() throws IOException {
    WebSocketSession s = joinedSession("program", 3);

    publisher.quizDeleted(3, 8, 77);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("quiz:deleted");
    assertThat(e.get("quizId").asLong()).isEqualTo(77);
  }

  @Test
  @DisplayName("quiz:attempt-graded → room de l'AUTEUR uniquement")
  void quizAttemptGraded() throws IOException {
    WebSocketSession author = joinedSession("user", 2);
    WebSocketSession someoneElse = joinedSession("user", 6);

    publisher.quizAttemptGraded(2, 4, 70);

    JsonNode e = capturePayload(author);
    assertThat(e.get("type").asText()).isEqualTo("quiz:attempt-graded");
    assertThat(e.get("userId").asLong()).isEqualTo(2);
    assertThat(e.get("quizId").asLong()).isEqualTo(4);
    assertThat(e.get("attemptId").asLong()).isEqualTo(70);
    verify(someoneElse, never()).sendMessage(any());
  }

  @Test
  @DisplayName("quiz:attempt-failed → room user, raison null conservée (libellé générique côté front)")
  void quizAttemptFailed() throws IOException {
    WebSocketSession s = joinedSession("user", 2);

    publisher.quizAttemptFailed(2, 4, 70, null);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("quiz:attempt-failed");
    assertThat(e.get("attemptId").asLong()).isEqualTo(70);
    assertThat(e.has("reason")).isTrue();
    assertThat(e.get("reason").isNull()).isTrue();
  }

  // ── Programmes / abonnements / rôles (scope user) ────────────────────────

  @Test
  @DisplayName("program:created → room user avec le programme")
  void programCreated() throws IOException {
    WebSocketSession s = joinedSession("user", 2);

    publisher.programCreated(2, new ProgramDto(7, "Génie info", "GI", "2026", "#123456"));

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("program:created");
    assertThat(e.get("program").get("id").asLong()).isEqualTo(7);
    assertThat(e.get("program").get("color").asText()).isEqualTo("#123456");
  }

  @Test
  @DisplayName("subscription:added → room user avec le programme")
  void subscriptionAdded() throws IOException {
    WebSocketSession s = joinedSession("user", 2);

    publisher.subscriptionAdded(2, new ProgramDto(7, "Génie info", "GI", "2026", "#123456"));

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("subscription:added");
    assertThat(e.get("userId").asLong()).isEqualTo(2);
    assertThat(e.get("program").get("code").asText()).isEqualTo("GI");
  }

  @Test
  @DisplayName("subscription:removed → room user avec l'id du programme")
  void subscriptionRemoved() throws IOException {
    WebSocketSession s = joinedSession("user", 2);

    publisher.subscriptionRemoved(2, 7);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("subscription:removed");
    assertThat(e.get("programId").asLong()).isEqualTo(7);
  }

  @Test
  @DisplayName("program:roleChanged → room user avec le rôle restant (ou null)")
  void programRoleChanged() throws IOException {
    WebSocketSession s = joinedSession("user", 2);

    publisher.programRoleChanged(2, 7, "Enseignant");

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("program:roleChanged");
    assertThat(e.get("programId").asLong()).isEqualTo(7);
    assertThat(e.get("roleName").asText()).isEqualTo("Enseignant");
  }

  @Test
  @DisplayName("user:globalRolesChanged → room user avec la liste des rôles globaux")
  void globalRolesChanged() throws IOException {
    WebSocketSession s = joinedSession("user", 2);

    publisher.globalRolesChanged(2, List.of(new RoleDto(1, "Administrateur")));

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("user:globalRolesChanged");
    assertThat(e.get("roles").get(0).get("id").asInt()).isEqualTo(1);
    assertThat(e.get("roles").get(0).get("name").asText()).isEqualTo("Administrateur");
  }

  // ── Établissements (room unique establishment:0) ─────────────────────────

  @Test
  @DisplayName("establishment:updated → room establishment:0 avec les programmes")
  void establishmentUpdated() throws IOException {
    WebSocketSession catalog = joinedSession("establishment", 0);
    WebSocketSession wrongRoom = joinedSession("establishment", 5);

    publisher.establishmentUpdated(5, List.of(new ProgramDto(7, "Génie info", "GI", "2026", "#123456")));

    JsonNode e = capturePayload(catalog);
    assertThat(e.get("type").asText()).isEqualTo("establishment:updated");
    assertThat(e.get("establishmentId").asLong()).isEqualTo(5);
    assertThat(e.get("programs").get(0).get("name").asText()).isEqualTo("Génie info");
    verify(wrongRoom, never()).sendMessage(any());
  }

  @Test
  @DisplayName("establishment:upserted → room establishment:0 avec nom, domaine et codes")
  void establishmentUpserted() throws IOException {
    WebSocketSession s = joinedSession("establishment", 0);

    publisher.establishmentUpserted(5, "UdeS", "usherbrooke.ca", 2, List.of("GI", "INFO"));

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("establishment:upserted");
    assertThat(e.get("id").asLong()).isEqualTo(5);
    assertThat(e.get("name").asText()).isEqualTo("UdeS");
    assertThat(e.get("domainEmail").asText()).isEqualTo("usherbrooke.ca");
    assertThat(e.get("programCount").asInt()).isEqualTo(2);
    assertThat(e.get("programCodes").get(1).asText()).isEqualTo("INFO");
  }

  @Test
  @DisplayName("establishment:deleted → room establishment:0")
  void establishmentDeleted() throws IOException {
    WebSocketSession s = joinedSession("establishment", 0);

    publisher.establishmentDeleted(5);

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("establishment:deleted");
    assertThat(e.get("establishmentId").asLong()).isEqualTo(5);
  }

  // ── MCP / profil ─────────────────────────────────────────────────────────

  @Test
  @DisplayName("mcp:analysis-progress → room mcp du cours, étape et lanceur")
  void mcpAnalysisProgress() throws IOException {
    WebSocketSession s = joinedSession("mcp", 8);

    publisher.mcpAnalysisProgress(8, 4, "collecting");

    JsonNode e = capturePayload(s);
    assertThat(e.get("type").asText()).isEqualTo("mcp:analysis-progress");
    assertThat(e.get("courseId").asLong()).isEqualTo(8);
    assertThat(e.get("userId").asLong()).isEqualTo(4);
    assertThat(e.get("step").asText()).isEqualTo("collecting");
  }

  @Test
  @DisplayName("user:updated → diffusé à TOUTES les sessions (une fois chacune)")
  void userUpdated_diffusionGlobale() throws IOException {
    WebSocketSession inChannel = joinedSession("channel", 5);
    WebSocketSession inForum = joinedSession("forum", 9);
    // Même session dans deux rooms : ne doit recevoir l'évènement qu'une fois.
    registry.join("program", 3, inForum);

    publisher.userUpdated(new Author(2, "rosie", "Rosie", "Tremblay", "#0a5cc0"));

    JsonNode e = capturePayload(inChannel);
    assertThat(e.get("type").asText()).isEqualTo("user:updated");
    assertThat(e.get("user").get("username").asText()).isEqualTo("rosie");
    assertThat(e.get("user").get("lastName").asText()).isEqualTo("Tremblay");
    assertThat(capturePayload(inForum).get("type").asText()).isEqualTo("user:updated");
  }

  // ── Robustesse ───────────────────────────────────────────────────────────

  @Test
  @DisplayName("Échec de sérialisation → rien n'est diffusé, aucune exception remontée")
  void echecSerialisation_rienNestDiffuse() throws IOException {
    ObjectMapper failing = mock(ObjectMapper.class);
    when(failing.writeValueAsString(any())).thenThrow(new JsonProcessingException("boom") {});
    RealtimeEventPublisher broken = new RealtimeEventPublisher(registry, failing);
    WebSocketSession s = joinedSession("program", 3);

    broken.quizCreated(3, 8, 77);
    broken.userUpdated(new Author(2, "rosie", "Rosie", "Tremblay"));

    verify(s, never()).sendMessage(any());
  }
}
