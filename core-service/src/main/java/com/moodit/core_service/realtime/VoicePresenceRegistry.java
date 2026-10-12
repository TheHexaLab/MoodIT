// Présence vocale EN MÉMOIRE : qui est connecté dans quel salon vocal (forum de F_Type
// 'Voice'). Alimenté par les commandes WebSocket voice_join / voice_leave et vidé quand une
// session se ferme (onglet fermé / crash) — d'où le choix de la porter sur le /ws applicatif
// plutôt que par webhooks LiveKit : le nettoyage est automatique.
//
// Autorité : la VÉRITÉ du média reste LiveKit ; ceci n'est qu'un reflet applicatif pour la
// sidebar. Un léger décalage (ex. coupure réseau LiveKit sans fermeture du /ws) est toléré.
//
// Chaque entrée mémorise aussi courseId + programIds (résolus une fois au join) pour pouvoir
// diffuser/filtrer sans retoucher la BD à chaque changement.

package com.moodit.core_service.realtime;

import com.moodit.core_service.realtime.dto.VoicePresenceParticipant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(prefix = "moodit.voice", name = "enabled", havingValue = "true")
public class VoicePresenceRegistry {

  /** Routage d'un salon : de quoi diffuser sa présence (sans toucher la BD). */
  public record Routing(int forumId, int courseId, List<Integer> programIds) {}

  private static final class Entry {
    final int courseId;
    final List<Integer> programIds;
    // Insertion-ordonné : l'ordre d'affichage suit l'ordre d'arrivée.
    final Map<String, VoicePresenceParticipant> bySession = new LinkedHashMap<>();

    Entry(int courseId, List<Integer> programIds) {
      this.courseId = courseId;
      this.programIds = programIds;
    }
  }

  private final Map<Integer, Entry> byForum = new HashMap<>();
  private final Map<String, Set<Integer>> sessionForums = new HashMap<>();

  public synchronized void join(
      int forumId,
      int courseId,
      List<Integer> programIds,
      String sessionId,
      VoicePresenceParticipant participant) {
    Entry entry = byForum.computeIfAbsent(forumId, k -> new Entry(courseId, programIds));
    entry.bySession.put(sessionId, participant);
    sessionForums.computeIfAbsent(sessionId, k -> new HashSet<>()).add(forumId);
  }

  /** Retire la session d'un salon ; renvoie le routage pour re-diffuser (ou null si rien). */
  public synchronized Routing leave(int forumId, String sessionId) {
    Entry entry = byForum.get(forumId);
    if (entry == null) {
      return null;
    }
    entry.bySession.remove(sessionId);
    Set<Integer> forums = sessionForums.get(sessionId);
    if (forums != null) {
      forums.remove(forumId);
      if (forums.isEmpty()) {
        sessionForums.remove(sessionId);
      }
    }
    Routing routing = new Routing(forumId, entry.courseId, entry.programIds);
    if (entry.bySession.isEmpty()) {
      byForum.remove(forumId);
    }
    return routing;
  }

  /** Déconnexion : retire la session de TOUS ses salons ; renvoie leurs routages à re-diffuser. */
  public synchronized List<Routing> removeSession(String sessionId) {
    Set<Integer> forums = sessionForums.remove(sessionId);
    if (forums == null) {
      return List.of();
    }
    List<Routing> affected = new ArrayList<>();
    for (int forumId : forums) {
      Entry entry = byForum.get(forumId);
      if (entry == null) {
        continue;
      }
      entry.bySession.remove(sessionId);
      affected.add(new Routing(forumId, entry.courseId, entry.programIds));
      if (entry.bySession.isEmpty()) {
        byForum.remove(forumId);
      }
    }
    return affected;
  }

  public synchronized List<VoicePresenceParticipant> participants(int forumId) {
    Entry entry = byForum.get(forumId);
    return entry == null ? List.of() : new ArrayList<>(entry.bySession.values());
  }

  /** Salons AYANT de la présence et visibles depuis ce programme (snapshot à l'abonnement). */
  public synchronized List<Routing> roomsForProgram(int programId) {
    List<Routing> rooms = new ArrayList<>();
    byForum.forEach(
        (forumId, entry) -> {
          if (!entry.bySession.isEmpty() && entry.programIds.contains(programId)) {
            rooms.add(new Routing(forumId, entry.courseId, entry.programIds));
          }
        });
    return rooms;
  }
}
