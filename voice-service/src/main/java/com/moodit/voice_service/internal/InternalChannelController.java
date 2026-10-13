// Endpoint INTERNE : core-service signale des CANAUX SUPPRIMES (forum supprime seul, via
// l'editeur de section, ou avec son cours). Les salons vocaux correspondants encore actifs sont
// fermes : sans ca, les participants deja connectes y resteraient jusqu'a l'expiration de leur
// JoinToken (le refus d'acces ne vaut que pour les NOUVELLES connexions).
// core ne connait pas forcement le type des forums supprimes : il envoie tous les ids, et seuls
// les salons ACTIFS sont touches (un seul ListRooms, puis DeleteRoom).

package com.moodit.voice_service.internal;

import com.moodit.voice_service.moderation.VoiceModerationService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/channels")
public class InternalChannelController {

  /** Ids des forums supprimes. Borne : un cours a rarement plus de quelques dizaines de forums. */
  public record DeletedChannels(@NotNull @Size(max = 1000) List<@NotNull Long> channelIds) {}

  private final VoiceModerationService moderation;
  private final InternalToken internalToken;

  public InternalChannelController(VoiceModerationService moderation, InternalToken internalToken) {
    this.moderation = moderation;
    this.internalToken = internalToken;
  }

  @PostMapping("/deleted")
  public ResponseEntity<Map<String, Integer>> deleted(
      @RequestHeader(value = "X-Internal-Token", required = false) String token,
      @Valid @RequestBody DeletedChannels body) {
    if (internalToken.rejects(token)) {
      return ResponseEntity.status(403).build();
    }
    List<String> rooms = body.channelIds().stream().map(id -> "channel:" + id).toList();
    return ResponseEntity.ok(Map.of("closed", moderation.closeRooms(rooms)));
  }
}
