// Vérifie la validation du JWT à l'ouverture du WebSocket : token bien signé accepté
// (email = subject), token absent / falsifié / signé avec une autre clé rejeté.

package com.moodit.core_service.realtime;

import static org.assertj.core.api.Assertions.assertThat;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import javax.crypto.SecretKey;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class WsJwtValidatorTest {

  private static final String SECRET = "test-secret-suffisamment-long-pour-hmac-sha256!";
  private final WsJwtValidator validator = new WsJwtValidator();

  @BeforeEach
  void setUp() {
    ReflectionTestUtils.setField(validator, "jwtSecret", SECRET);
  }

  private SecretKey key(String secret) {
    return Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void tokenValide_renvoieLEmail() {
    String token = Jwts.builder().subject("rosie@usherbrooke.ca").signWith(key(SECRET)).compact();
    assertThat(validator.validateAndGetEmail(token)).isEqualTo("rosie@usherbrooke.ca");
  }

  @Test
  void tokenNullOuVide_renvoieNull() {
    assertThat(validator.validateAndGetEmail(null)).isNull();
    assertThat(validator.validateAndGetEmail("   ")).isNull();
  }

  @Test
  void tokenFalsifie_renvoieNull() {
    assertThat(validator.validateAndGetEmail("pas.un.jwt")).isNull();
  }

  @Test
  void tokenSigneAvecUneAutreCle_renvoieNull() {
    String token =
        Jwts.builder()
            .subject("rosie@usherbrooke.ca")
            .signWith(key("une-tout-autre-cle-aussi-longue-mais-fausse!"))
            .compact();
    assertThat(validator.validateAndGetEmail(token)).isNull();
  }
}
