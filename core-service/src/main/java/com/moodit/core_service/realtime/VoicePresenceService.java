// Orchestration de la présence vocale : autorise, résout l'utilisateur + le routage
// (forum → cours → programmes), met à jour le registre et diffuse `voice:presence` sur la/les
// room(s) `program:<id>` (celles que la sidebar écoute déjà). Greffon retirable : tout est
// conditionné par moodit.voice.enabled.

package com.moodit.core_service.realtime;

import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.dto.VoicePresenceParticipant;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.UserRepository;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.socket.WebSocketSession;

@Service
@ConditionalOnProperty(prefix = "moodit.voice", name = "enabled", havingValue = "true")
public class VoicePresenceService {

  private static final Logger log = LoggerFactory.getLogger(VoicePresenceService.class);

  private final VoicePresenceRegistry registry;
  private final RoomAuthorizer authorizer;
  private final UserRepository users;
  private final ForumRepository forums;
  private final RealtimeEventPublisher publisher;

  public VoicePresenceService(
      VoicePresenceRegistry registry,
      RoomAuthorizer authorizer,
      UserRepository users,
      ForumRepository forums,
      RealtimeEventPublisher publisher) {
    this.registry = registry;
    this.authorizer = authorizer;
    this.users = users;
    this.forums = forums;
    this.publisher = publisher;
  }

  /** L'utilisateur rejoint le salon vocal `forumId` : même autorisation que le JoinToken. */
  @Transactional(readOnly = true)
  public void join(String email, WebSocketSession session, int forumId) {
    if (!authorizer.canJoin(email, "channel", forumId)) {
      log.debug("Présence vocale REFUSÉE : {} sur channel:{}", email, forumId);
      return;
    }
    User user = users.findByEmail(email).orElse(null);
    Integer courseId = forums.findCourseIdById(forumId).orElse(null);
    if (user == null || courseId == null) {
      return;
    }
    List<Integer> programIds = forums.findProgramIdsById(forumId);
    registry.join(
        forumId,
        courseId,
        programIds,
        session.getId(),
        new VoicePresenceParticipant(user.getId(), displayName(user)));
    broadcast(forumId, courseId, programIds);
  }

  public void leave(WebSocketSession session, int forumId) {
    VoicePresenceRegistry.Routing routing = registry.leave(forumId, session.getId());
    if (routing != null) {
      broadcast(routing.forumId(), routing.courseId(), routing.programIds());
    }
  }

  /** Session fermée (onglet / crash) : la retire de tous ses salons et re-diffuse. */
  public void removeSession(WebSocketSession session) {
    for (VoicePresenceRegistry.Routing routing : registry.removeSession(session.getId())) {
      broadcast(routing.forumId(), routing.courseId(), routing.programIds());
    }
  }

  /** À l'abonnement d'une session au programme : lui envoyer l'état courant (pas aux autres). */
  public void sendSnapshot(WebSocketSession session, int programId) {
    for (VoicePresenceRegistry.Routing routing : registry.roomsForProgram(programId)) {
      publisher.voicePresenceTo(
          session,
          programId,
          routing.courseId(),
          routing.forumId(),
          registry.participants(routing.forumId()));
    }
  }

  private void broadcast(int forumId, int courseId, List<Integer> programIds) {
    List<VoicePresenceParticipant> participants = registry.participants(forumId);
    for (int programId : programIds) {
      publisher.voicePresence(programId, courseId, forumId, participants);
    }
  }

  private static String displayName(User user) {
    String first = user.getFirstName() == null ? "" : user.getFirstName();
    String last = user.getLastName() == null ? "" : user.getLastName();
    String full = (first + " " + last).trim();
    return full.isEmpty() ? user.getUsername() : full;
  }
}
