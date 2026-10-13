// Moderation d'un salon vocal (canal = Forum de F_Type 'Voice'), par un MODERATEUR :
//   POST   /api/voice/channels/{channelId}/participants/{userId}/mute  → server-mute
//   DELETE /api/voice/channels/{channelId}/participants/{userId}/mute  → lever le server-mute
//   POST   /api/voice/channels/{channelId}/participants/{userId}/kick  → expulser
// userId = User_.id de la personne visee (= partie avant le "." de son identite LiveKit).
//
// Moderateur (permission-service, scope "voiceModerate") : Administrateur/Gardien GLOBAL, ou
// Administrateur/Enseignant d'un programme du cours du canal. Le gateway applique deja la meme
// regle (/permissions/validate) ; on la re-verifie ici comme pour le JoinToken (fail-closed).

package com.moodit.voice_service.moderation;

import com.moodit.voice_service.authz.RoomAuthorizer;
import com.moodit.voice_service.moderation.VoiceModerationService.NotInRoomException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/voice/channels/{channelId}/participants/{userId}")
public class VoiceModerationController {

  /** Scope permission-service : « peut moderer le salon vocal de ce canal ». */
  public static final String MODERATE_SCOPE = "voiceModerate";

  private final RoomAuthorizer authorizer;
  private final VoiceModerationService moderation;

  public VoiceModerationController(RoomAuthorizer authorizer, VoiceModerationService moderation) {
    this.authorizer = authorizer;
    this.moderation = moderation;
  }

  @PostMapping("/mute")
  public ResponseEntity<Void> mute(
      @RequestHeader(value = "X-User-Email", required = false) String email,
      @PathVariable long channelId,
      @PathVariable int userId) {
    requireModerator(email, channelId);
    moderation.serverMute(room(channelId), userId);
    return ResponseEntity.noContent().build();
  }

  @DeleteMapping("/mute")
  public ResponseEntity<Void> unmute(
      @RequestHeader(value = "X-User-Email", required = false) String email,
      @PathVariable long channelId,
      @PathVariable int userId) {
    requireModerator(email, channelId);
    moderation.liftServerMute(room(channelId), userId);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/kick")
  public ResponseEntity<Map<String, Integer>> kick(
      @RequestHeader(value = "X-User-Email", required = false) String email,
      @PathVariable long channelId,
      @PathVariable int userId) {
    requireModerator(email, channelId);
    int removed = moderation.kick(room(channelId), userId);
    return ResponseEntity.ok(Map.of("removedDevices", removed));
  }

  @ExceptionHandler(NotInRoomException.class)
  ResponseEntity<Map<String, String>> notInRoom(NotInRoomException e) {
    return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("message", e.getMessage()));
  }

  private void requireModerator(String email, long channelId) {
    if (email == null || email.isBlank()) {
      throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentification requise");
    }
    if (!authorizer.canJoin(email, MODERATE_SCOPE, channelId)) {
      throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Moderation du salon refusee");
    }
  }

  /** Meme convention que le JoinToken (VoiceTokenController). */
  static String room(long channelId) {
    return "channel:" + channelId;
  }
}
