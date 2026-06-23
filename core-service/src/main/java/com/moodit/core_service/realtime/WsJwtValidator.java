// Validation locale du JWT présenté à l'ouverture du WebSocket (signature +
// expiration, même secret HMAC que le gateway et l'auth-service). On valide
// uniquement la signature ici : la validation forte « token actif » (révocation /
// session unique) reste du ressort de l'auth-service pour les routes REST.

package com.moodit.core_service.realtime;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import javax.crypto.SecretKey;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class WsJwtValidator {

  @Value("${app.jwt.secret}")
  private String jwtSecret;

  /** Renvoie l'email (subject) si le token est valide, sinon null. */
  public String validateAndGetEmail(String token) {
    if (token == null || token.isBlank()) {
      return null;
    }
    try {
      Claims claims =
          Jwts.parser()
              .verifyWith(getSigningKey())
              .build()
              .parseSignedClaims(token)
              .getPayload();
      return claims.getSubject();
    } catch (Exception e) {
      return null;
    }
  }

  private SecretKey getSigningKey() {
    return Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
  }
}
