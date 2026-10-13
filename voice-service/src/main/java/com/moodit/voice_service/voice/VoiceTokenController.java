// POST /api/voice/token — delivre un JoinToken LiveKit pour un salon vocal.
//
// UNIQUE point de controle d'acces au vocal : on REUTILISE le permission-service (le meme
// oui/non que le join WebSocket temps reel et que le chat texte du salon), donc aucune logique
// d'autorisation dupliquee ici.
//
// Routage : le gateway envoie /api/voice/** vers ce service SANS strip du prefixe, on mappe donc
// le chemin COMPLET "/api/voice/token" (pas de WebMvcConfig /api comme dans core). L'identite
// vient du header X-User-Email pose par le gateway apres validation du JWT — jamais du client.

package com.moodit.voice_service.voice;

import com.moodit.voice_service.authz.RoomAuthorizer;
import com.moodit.voice_service.device.DeviceOwnershipClient;
import com.moodit.voice_service.device.DeviceOwnershipClient.DeviceOwner;
import com.moodit.voice_service.moderation.VoiceModerationController;
import com.moodit.voice_service.moderation.VoiceModerationService;
import com.moodit.voice_service.voice.dto.VoiceTokenRequest;
import com.moodit.voice_service.voice.dto.VoiceTokenResponse;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class VoiceTokenController {

  /** Scope d'autorisation : un salon vocal EST un channel (memes droits que le chat texte). */
  private static final String SCOPE = "channel";

  private final RoomAuthorizer authorizer;
  private final DeviceOwnershipClient devices;
  private final LiveKitTokenFactory tokenFactory;
  private final VoiceModerationService moderation;
  private final VoiceProperties props;

  public VoiceTokenController(
      RoomAuthorizer authorizer,
      DeviceOwnershipClient devices,
      LiveKitTokenFactory tokenFactory,
      VoiceModerationService moderation,
      VoiceProperties props) {
    this.authorizer = authorizer;
    this.devices = devices;
    this.tokenFactory = tokenFactory;
    this.moderation = moderation;
    this.props = props;
  }

  @PostMapping("/api/voice/token")
  public ResponseEntity<VoiceTokenResponse> token(
      @RequestHeader(value = "X-User-Email", required = false) String email,
      @Valid @RequestBody VoiceTokenRequest body) {

    // Appel direct sans passer par le gateway (pas de X-User-Email) : aucune identite.
    if (email == null || email.isBlank()) {
      throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentification requise");
    }

    // Fail-closed : permission injoignable ou droit absent => pas de token (RemoteRoomAuthorizer).
    if (!authorizer.canJoin(email, SCOPE, body.channelId())) {
      throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Acces au salon vocal refuse");
    }

    // L'appareil doit etre ACTIF et a cet utilisateur (annuaire core, fail-closed). Sans ca, un
    // client pourrait se presenter sous le deviceId d'un autre (il ne pourrait pas dechiffrer,
    // mais usurperait son identite affichee dans le salon).
    DeviceOwner owner =
        devices
            .activeOwner(body.deviceId(), email)
            .orElseThrow(
                () -> new ResponseStatusException(HttpStatus.FORBIDDEN, "Appareil non reconnu"));

    String room = SCOPE + ":" + body.channelId();
    // Identite "<userId>.<deviceId>" (E2EE.md §5.4) : l'email n'est plus visible des autres
    // participants, et deux navigateurs du meme compte ne s'ejectent plus (DUPLICATE_IDENTITY).
    String identity = owner.userId() + "." + body.deviceId();
    // Server-mute en cours (moderateur) : le token n'autorise pas le micro, sinon il suffirait
    // de se reconnecter pour le retrouver.
    boolean serverMuted = moderation.isServerMuted(room, owner.userId());
    String joinToken =
        tokenFactory.createJoinToken(
            room,
            identity,
            owner.username(),
            serverMuted ? VoiceModerationService.GRANT_SOURCES_WITHOUT_MIC : null);
    // Le front n'affiche les actions de moderation qu'a un moderateur (le serveur re-verifie).
    boolean canModerate =
        authorizer.canJoin(email, VoiceModerationController.MODERATE_SCOPE, body.channelId());

    return ResponseEntity.ok(
        new VoiceTokenResponse(
            joinToken, props.livekit().url(), room, owner.userId(), canModerate, serverMuted));
  }
}
