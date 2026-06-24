// Point d'entrée pour DIFFUSER les évènements temps réel. Les contrôleurs / services
// REST appellent ces méthodes après avoir persisté une donnée ; chaque évènement
// est sérialisé en JSON puis poussé à toutes les sessions de la room concernée.
//
// Le format de chaque évènement reproduit EXACTEMENT l'union `ServerEvent` du front
// (frontend/src/services/appSocket.ts) :
//
//   message:created / edited / deleted        → room "channel:<channelId>"
//   post:created / edited / deleted / voted    → room "forum:<forumId>"
//   course:created / edited / deleted          → room "program:<programId>"
//   section:changed                            → room "program:<programId>"
//   program:created / updated / deleted        → room "user:<userId>"
//   subscription:added / removed               → room "user:<userId>"
//
// ⚠ Pour le chat et le forum, l'évènement *:created doit ré-émettre le
// `client_msg_id` / `client_post_id` reçu au POST : c'est ce qui permet au front
// de dédupliquer l'écho de son propre message optimiste.

package com.moodit.core_service.realtime;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.realtime.dto.ChannelMessageDto;
import com.moodit.core_service.realtime.dto.CourseDto;
import com.moodit.core_service.realtime.dto.ForumPostDto;
import com.moodit.core_service.realtime.dto.ItemChangeDto;
import com.moodit.core_service.realtime.dto.McpResponseSummaryDto;
import com.moodit.core_service.realtime.dto.ProgramDto;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class RealtimeEventPublisher {

  private static final Logger log = LoggerFactory.getLogger(RealtimeEventPublisher.class);

  private final SubscriptionRegistry registry;
  private final ObjectMapper objectMapper;

  public RealtimeEventPublisher(SubscriptionRegistry registry, ObjectMapper objectMapper) {
    this.registry = registry;
    this.objectMapper = objectMapper;
  }

  // ─── Chat (scope = channel) ───────────────────────────────────────────────

  public void messageCreated(long channelId, ChannelMessageDto message) {
    emit(
        "channel",
        channelId,
        event("message:created", "channelId", channelId, "message", message));
  }

  public void messageEdited(long channelId, long messageId, String content) {
    emit(
        "channel",
        channelId,
        event("message:edited", "channelId", channelId, "messageId", messageId, "content", content));
  }

  public void messageDeleted(long channelId, long messageId) {
    emit(
        "channel",
        channelId,
        event("message:deleted", "channelId", channelId, "messageId", messageId));
  }

  // ─── Forum (scope = forum) ────────────────────────────────────────────────

  public void postCreated(long forumId, ForumPostDto post, Long parentId) {
    emit(
        "forum",
        forumId,
        event("post:created", "forumId", forumId, "post", post, "parentId", parentId));
  }

  public void postEdited(long forumId, long postId, String content) {
    emit(
        "forum",
        forumId,
        event("post:edited", "forumId", forumId, "postId", postId, "content", content));
  }

  public void postDeleted(long forumId, long postId) {
    emit("forum", forumId, event("post:deleted", "forumId", forumId, "postId", postId));
  }

  /** value ∈ {-1, 0, 1} ; 0 = retrait du vote. */
  public void postVoted(long forumId, long postId, long userId, int value) {
    emit(
        "forum",
        forumId,
        event(
            "post:voted",
            "forumId", forumId,
            "postId", postId,
            "userId", userId,
            "value", value));
  }

  // ─── Cours / sections (scope = program) ───────────────────────────────────

  public void courseCreated(long programId, CourseDto course) {
    emit("program", programId, event("course:created", "programId", programId, "course", course));
  }

  public void courseEdited(long programId, CourseDto course) {
    emit("program", programId, event("course:edited", "programId", programId, "course", course));
  }

  public void courseDeleted(long programId, long courseId) {
    emit(
        "program",
        programId,
        event("course:deleted", "programId", programId, "courseId", courseId));
  }

  public void sectionChanged(
      long programId, long courseId, String sectionType, ItemChangeDto change) {
    emit(
        "program",
        programId,
        event(
            "section:changed",
            "programId", programId,
            "courseId", courseId,
            "sectionType", sectionType,
            "change", change));
  }

  // ─── Programmes / abonnements (scope = user) ──────────────────────────────

  public void programCreated(long userId, ProgramDto program) {
    emit("user", userId, event("program:created", "userId", userId, "program", program));
  }

  public void programUpdated(long userId, ProgramDto program) {
    emit("user", userId, event("program:updated", "userId", userId, "program", program));
  }

  public void programDeleted(long userId, long programId) {
    emit("user", userId, event("program:deleted", "userId", userId, "programId", programId));
  }

  public void subscriptionAdded(long userId, ProgramDto program) {
    emit("user", userId, event("subscription:added", "userId", userId, "program", program));
  }

  public void subscriptionRemoved(long userId, long programId) {
    emit("user", userId, event("subscription:removed", "userId", userId, "programId", programId));
  }

  // ─── Analyses MCP (scope = course) ────────────────────────────────────────
  // Poussé quand un job d'analyse MCP se termine. Room "mcp:<courseId>" : tous les
  // abonnés au feedback de ce cours reçoivent le RÉSUMÉ (le détail se fetch au clic).

  public void mcpAnalysisCreated(long courseId, McpResponseSummaryDto analysis) {
    emit(
        "mcp",
        courseId,
        event("mcp:analysis-created", "courseId", courseId, "analysis", analysis));
  }

  /**
   * Job d'analyse MCP ÉCHOUÉ (LLM indisponible, timeout…). Porte le `userId` du LANCEUR :
   * seul lui doit voir l'erreur et pouvoir relancer (le verrou est par (cours, user)).
   * `reason` optionnel : message d'erreur à afficher (null → libellé générique du front).
   */
  public void mcpAnalysisFailed(long courseId, long userId, String reason) {
    emit(
        "mcp",
        courseId,
        event("mcp:analysis-failed", "courseId", courseId, "userId", userId, "reason", reason));
  }

  // ─── Interne ──────────────────────────────────────────────────────────────

  /** Sérialise l'évènement et le diffuse à la room (scope:id). */
  private void emit(String scope, long id, Map<String, Object> payload) {
    try {
      registry.broadcast(scope, id, objectMapper.writeValueAsString(payload));
    } catch (JsonProcessingException e) {
      log.error("Échec de sérialisation de l'évènement {} ({}:{})", payload.get("type"), scope, id, e);
    }
  }

  /**
   * Construit un objet évènement ordonné { type, ...champs }. Les valeurs nulles
   * sont conservées (ex. `parentId: null` pour un sujet racine) : c'est voulu, le
   * front distingue absence et null.
   */
  private static Map<String, Object> event(String type, Object... keyValues) {
    Map<String, Object> map = new LinkedHashMap<>();
    map.put("type", type);
    for (int i = 0; i + 1 < keyValues.length; i += 2) {
      map.put((String) keyValues[i], keyValues[i + 1]);
    }
    return map;
  }
}
