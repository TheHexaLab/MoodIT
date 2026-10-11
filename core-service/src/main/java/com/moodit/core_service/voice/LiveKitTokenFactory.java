// Fabrique de JoinToken LiveKit. Un JoinToken est un JWT HS256 signe avec le secret d'API
// LiveKit, portant un "video grant" qui dit quel salon l'utilisateur peut rejoindre et avec
// quels droits. LiveKit le verifie a la connexion WebRTC : c'est l'equivalent du "token a
// usage unique" de la doc (section 4) — ici, aucun secret ne transite vers le navigateur,
// seul le JWT signe part.
//
// On reutilise jjwt (deja present pour les JWT d'auth MoodIT), donc zero nouvelle dependance.

package com.moodit.core_service.voice;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.Map;
import javax.crypto.SecretKey;

public class LiveKitTokenFactory {

  private final VoiceProperties props;
  private final SecretKey key;

  public LiveKitTokenFactory(VoiceProperties props) {
    this.props = props;
    // HS256 exige une cle >= 32 octets : si le secret est trop court, Keys leve une
    // WeakKeyException au demarrage (fail-fast) plutot que de signer un token faible.
    this.key = Keys.hmacShaKeyFor(props.livekit().apiSecret().getBytes(StandardCharsets.UTF_8));
  }

  /**
   * @param room identifiant du salon LiveKit (convention MoodIT : "channel:&lt;id&gt;")
   * @param identity identite du participant, visible des autres membres du salon
   * @return un JWT signe a passer au SDK LiveKit cote navigateur
   */
  public String createJoinToken(String room, String identity) {
    Instant now = Instant.now();
    return Jwts.builder()
        .issuer(props.livekit().apiKey()) // LiveKit retrouve le secret via la cle (iss)
        .subject(identity)
        .issuedAt(Date.from(now))
        .notBefore(Date.from(now))
        .expiration(Date.from(now.plusSeconds(props.tokenTtlSeconds())))
        // "video grant" : schema impose par LiveKit. roomJoin + room borne l'acces a CE salon.
        .claim(
            "video",
            Map.of(
                "roomJoin", true,
                "room", room,
                "canPublish", true,
                "canSubscribe", true,
                "canPublishData", true))
        .signWith(key)
        .compact();
  }
}
