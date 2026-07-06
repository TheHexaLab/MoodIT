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
import com.moodit.core_service.realtime.dto.Author;
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

  /** `title` = nouveau titre d'un sujet racine ('Thread'), ou null pour une réponse. */
  public void postEdited(long forumId, long postId, String content, String title) {
    emit(
        "forum",
        forumId,
        event(
            "post:edited", "forumId", forumId, "postId", postId, "content", content, "title", title));
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

  /** Un quiz a été AJOUTÉ au cours : les clients rafraîchissent la liste (pas de bannière). */
  public void quizCreated(long programId, long courseId, long quizId) {
    emit(
        "program",
        programId,
        event("quiz:created", "programId", programId, "courseId", courseId, "quizId", quizId));
  }

  /**
   * Un quiz a été MODIFIÉ : les clients rafraîchissent la liste, et celui qui l'a ouvert
   * voit une bannière « quiz modifié — recharger ».
   */
  public void quizUpdated(long programId, long courseId, long quizId) {
    emit(
        "program",
        programId,
        event("quiz:updated", "programId", programId, "courseId", courseId, "quizId", quizId));
  }

  /** Les quiz d'un cours ont été réordonnés : les clients rafraîchissent la liste. */
  public void quizReordered(long programId, long courseId) {
    emit(
        "program",
        programId,
        event("quiz:reordered", "programId", programId, "courseId", courseId));
  }

  /** Un quiz a été supprimé : les clients le retirent de la liste (et ferment la vue ouverte). */
  public void quizDeleted(long programId, long courseId, long quizId) {
    emit(
        "program",
        programId,
        event("quiz:deleted", "programId", programId, "courseId", courseId, "quizId", quizId));
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

  /**
   * Le rôle de l'utilisateur DANS un programme a changé (User_Program_Role) : ses menus
   * d'actions administratives se re-calculent LIVE. Scope user:&lt;userId&gt; (le rôle est
   * propre à cet utilisateur). `roleName` = rôle le plus élevé restant ("Administrateur",
   * "Enseignant") ou null (plus aucun rôle dans ce programme).
   */
  public void programRoleChanged(long userId, long programId, String roleName) {
    emit(
        "user",
        userId,
        event(
            "program:roleChanged",
            "userId", userId,
            "programId", programId,
            "roleName", roleName));
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

  /**
   * Étape de PROGRESSION d'un job d'analyse MCP en cours (feedback temps réel : collecte,
   * analyse IA, repli…). Porte le `userId` du LANCEUR (seul lui affiche la progression, le
   * verrou étant par (cours, user)). `step` = clé d'étape, mappée en libellé côté front.
   */
  public void mcpAnalysisProgress(long courseId, long userId, String step) {
    emit(
        "mcp",
        courseId,
        event("mcp:analysis-progress", "courseId", courseId, "userId", userId, "step", step));
  }

  // ─── Utilisateur (scope = GLOBAL) ─────────────────────────────────────────
  // Un utilisateur a modifié son profil (prénom / nom / couleur d'avatar). L'auteur peut
  // apparaître dans n'importe quel canal ou forum : on diffuse donc à TOUTES les sessions,
  // et chaque client met à jour l'auteur des messages/posts déjà chargés (par id).

  public void userUpdated(Author author) {
    emitAll(event("user:updated", "user", author));
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

  /** Sérialise l'évènement et le diffuse à TOUTES les sessions (évènement global). */
  private void emitAll(Map<String, Object> payload) {
    try {
      registry.broadcastAll(objectMapper.writeValueAsString(payload));
    } catch (JsonProcessingException e) {
      log.error("Échec de sérialisation de l'évènement global {}", payload.get("type"), e);
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
