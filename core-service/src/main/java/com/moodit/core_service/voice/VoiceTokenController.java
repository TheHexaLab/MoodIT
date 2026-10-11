// POST /api/voice/token — delivre un JoinToken LiveKit pour un salon vocal.
//
// C'est l'UNIQUE point de controle d'acces au vocal (doc section 8 : "verifier les
// permissions avant d'emettre le jeton vocal"). On REUTILISE RoomAuthorizer -> permission
// -service (le meme oui/non que le join WebSocket temps reel), donc aucune logique
// d'autorisation dupliquee : le vocal herite exactement des droits du salon texte.
//
// Le prefixe /api est ajoute globalement par WebMvcConfig : mapper "/voice/token" donne
// "/api/voice/token", route par le gateway (/api/** -> core-service). Ne PAS re-mettre /api.

package com.moodit.core_service.voice;

import com.moodit.core_service.realtime.RoomAuthorizer;
import com.moodit.core_service.voice.dto.VoiceTokenRequest;
import com.moodit.core_service.voice.dto.VoiceTokenResponse;
import jakarta.validation.Valid;
import java.security.Principal;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@ConditionalOnProperty(prefix = "moodit.voice", name = "enabled", havingValue = "true")
public class VoiceTokenController {

  /** Scope d'autorisation : un salon vocal EST un channel (meme droits que le chat texte). */
  private static final String SCOPE = "channel";

  private final RoomAuthorizer authorizer;
  private final LiveKitTokenFactory tokenFactory;
  private final VoiceProperties props;

  public VoiceTokenController(
      RoomAuthorizer authorizer, LiveKitTokenFactory tokenFactory, VoiceProperties props) {
    this.authorizer = authorizer;
    this.tokenFactory = tokenFactory;
    this.props = props;
  }

  @PostMapping("/voice/token")
  public ResponseEntity<VoiceTokenResponse> token(
      Principal principal, @Valid @RequestBody VoiceTokenRequest body) {

    // Appel direct sans passer par le gateway (pas de X-User-Email) : aucune identite.
    if (principal == null || principal.getName() == null || principal.getName().isBlank()) {
      throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentification requise");
    }
    String email = principal.getName();

    // Fail-closed : permission injoignable ou droit absent => pas de token (RemoteRoomAuthorizer).
    if (!authorizer.canJoin(email, SCOPE, body.channelId())) {
      throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Acces au salon vocal refuse");
    }

    String room = SCOPE + ":" + body.channelId();
    // TODO(J4, confidentialite) : l'email devient l'identite LiveKit, VISIBLE des autres
    // participants. Avant livraison, mapper email -> userId/username (comme Author ailleurs)
    // pour ne pas divulguer l'email des membres entre eux.
    String joinToken = tokenFactory.createJoinToken(room, email);

    return ResponseEntity.ok(new VoiceTokenResponse(joinToken, props.livekit().url(), room));
  }
}
