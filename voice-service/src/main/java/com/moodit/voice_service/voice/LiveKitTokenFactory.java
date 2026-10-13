// Fabrique de JoinToken LiveKit. Un JoinToken est un JWT HS256 signe avec le secret d'API
// LiveKit, portant un "video grant" qui dit quel salon l'utilisateur peut rejoindre et avec
// quels droits. LiveKit le verifie a la connexion WebRTC : aucun secret ne transite vers le
// navigateur, seul le JWT signe part.
//
// On reutilise jjwt (deja utilise ailleurs dans MoodIT), donc zero dependance exotique.

package com.moodit.voice_service.voice;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.HashMap;
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
   * @param identity identite technique du participant ("<userId>.<deviceId>"), unique par appareil
   * @param name nom d'affichage (username) montre aux autres participants
   * @return un JWT signe a passer au SDK LiveKit cote navigateur
   */
  public String createJoinToken(String room, String identity, String name) {
    Instant now = Instant.now();
    Map<String, Object> grant = new HashMap<>();
    // "video grant" : schema impose par LiveKit. roomJoin + room borne l'acces a CE salon.
    grant.put("roomJoin", true);
    grant.put("room", room);
    grant.put("canPublish", true);
    grant.put("canSubscribe", true);
    // Le data channel reste ouvert dans tous les cas : l'echange de cles E2EE en depend.
    grant.put("canPublishData", true);
    return Jwts.builder()
        .issuer(props.livekit().apiKey()) // LiveKit retrouve le secret via la cle (iss)
        .subject(identity)
        .claim("name", name) // claim standard LiveKit : participant.name cote SDK
        .issuedAt(Date.from(now))
        .notBefore(Date.from(now))
        .expiration(Date.from(now.plusSeconds(props.tokenTtlSeconds())))
        .claim("video", grant)
        // HS256 IMPOSE : LiveKit n'accepte que HS256. Sans l'algo explicite, jjwt le choisit
        // selon la taille du secret (>= 64 octets -> HS512, >= 48 -> HS384), ce qui fait rejeter
        // le token par LiveKit (401 /rtc/validate) des qu'on utilise un secret long en prod.
        .signWith(key, Jwts.SIG.HS256)
        .compact();
  }

  /**
   * Jeton d'ADMINISTRATION court (60 s) pour l'API serveur LiveKit (Twirp RoomService). Jamais
   * transmis a un navigateur : sert uniquement aux appels voice-service -> LiveKit.
   *
   * @param room salon administre (requis pour RemoveParticipant), ou null pour ListRooms
   */
  public String createAdminToken(String room) {
    Instant now = Instant.now();
    Map<String, Object> grant = new HashMap<>();
    grant.put("roomList", true);
    grant.put("roomAdmin", true);
    if (room != null) {
      grant.put("room", room);
    }
    return Jwts.builder()
        .issuer(props.livekit().apiKey())
        .subject("moodit-voice-service")
        .issuedAt(Date.from(now))
        .notBefore(Date.from(now))
        .expiration(Date.from(now.plusSeconds(60)))
        .claim("video", grant)
        .signWith(key, Jwts.SIG.HS256)
        .compact();
  }
}
