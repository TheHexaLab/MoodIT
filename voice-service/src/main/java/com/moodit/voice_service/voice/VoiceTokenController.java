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
  private final LiveKitTokenFactory tokenFactory;
  private final VoiceProperties props;

  public VoiceTokenController(
      RoomAuthorizer authorizer, LiveKitTokenFactory tokenFactory, VoiceProperties props) {
    this.authorizer = authorizer;
    this.tokenFactory = tokenFactory;
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

    String room = SCOPE + ":" + body.channelId();
    // TODO(confidentialite) : l'email devient l'identite LiveKit, VISIBLE des autres
    // participants. Avant livraison, mapper email -> userId/username pour ne pas divulguer
    // l'email des membres entre eux (idem TODO d'origine cote core).
    String joinToken = tokenFactory.createJoinToken(room, email);

    return ResponseEntity.ok(new VoiceTokenResponse(joinToken, props.livekit().url(), room));
  }
}
