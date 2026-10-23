package com.moodit.auth_service.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class JwtServiceTest {

  private JwtService jwtService;

  @BeforeEach
  void setUp() {
    jwtService = new JwtService();
    // HS256 exige une clé d'au moins 256 bits (32 octets).
    ReflectionTestUtils.setField(
        jwtService, "jwtSecret", "test-secret-suffisamment-longue-pour-hs256-0123456789");
    ReflectionTestUtils.setField(jwtService, "jwtExpiration", 3_600_000L);
  }

  @Test
  void generateThenValidate_roundTrips() {
    String token = jwtService.generateToken("user@usherbrooke.ca");

    assertThat(jwtService.isTokenValid(token)).isTrue();
    assertThat(jwtService.extractEmail(token)).isEqualTo("user@usherbrooke.ca");
  }

  @Test
  void isTokenValid_rejectsGarbage() {
    assertThat(jwtService.isTokenValid("pas-un-vrai-jwt")).isFalse();
  }

  @Test
  void getHashCount_alwaysBetween2And5() {
    String[] emails = {"a@x.ca", "bob@usherbrooke.ca", "z@y.io", "verylongemail@example.com"};
    for (String e : emails) {
      assertThat(jwtService.getHashCount(e)).isBetween(2, 5);
    }
  }

  @Test
  void hashToken_isDeterministic_andDiffersFromInput() {
    String token = jwtService.generateToken("user@usherbrooke.ca");
    String h1 = jwtService.hashToken(token, "user@usherbrooke.ca");
    String h2 = jwtService.hashToken(token, "user@usherbrooke.ca");

    assertThat(h1).isEqualTo(h2);
    assertThat(h1).isNotEqualTo(token);
  }

  @Test
  void isTokenValid_rejectsTokenSignedWithAnotherKey() {
    // Un jeton forgé avec une autre clé ne doit jamais être accepté.
    JwtService other = new JwtService();
    ReflectionTestUtils.setField(
        other, "jwtSecret", "une-autre-cle-tout-aussi-longue-pour-hs256-9876543210");
    ReflectionTestUtils.setField(other, "jwtExpiration", 3_600_000L);
    String forged = other.generateToken("user@usherbrooke.ca");

    assertThat(jwtService.isTokenValid(forged)).isFalse();
  }

  @Test
  void isTokenValid_rejectsExpiredToken() {
    ReflectionTestUtils.setField(jwtService, "jwtExpiration", -1_000L); // déjà expiré
    String expired = jwtService.generateToken("user@usherbrooke.ca");

    assertThat(jwtService.isTokenValid(expired)).isFalse();
  }

  @Test
  void isTokenValid_rejectsTamperedPayload() {
    String token = jwtService.generateToken("user@usherbrooke.ca");
    String[] parts = token.split("\\.");
    String tampered = parts[0] + "." + parts[1] + "x." + parts[2];

    assertThat(jwtService.isTokenValid(tampered)).isFalse();
  }

  @Test
  void getHashCount_followsCharSumModulo4() {
    // "a" = 97 → 97 % 4 = 1 → 3 passages ; "d" = 100 → 0 → 2 passages.
    assertThat(jwtService.getHashCount("a")).isEqualTo(3);
    assertThat(jwtService.getHashCount("d")).isEqualTo(2);
    assertThat(jwtService.getHashCount("c")).isEqualTo(5); // 99 % 4 = 3
  }

  @Test
  void hashToken_appliesSha256TheComputedNumberOfTimes() throws Exception {
    // "d" → 2 passages : le résultat doit être SHA-256(SHA-256(token)) en hexadécimal.
    java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
    java.util.HexFormat hex = java.util.HexFormat.of();
    String once = hex.formatHex(md.digest("tok".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    String twice = hex.formatHex(md.digest(once.getBytes(java.nio.charset.StandardCharsets.UTF_8)));

    assertThat(jwtService.hashToken("tok", "d")).isEqualTo(twice).hasSize(64);
  }

  @Test
  void hashToken_differsAcrossTokens() {
    assertThat(jwtService.hashToken("token-a", "user@usherbrooke.ca"))
        .isNotEqualTo(jwtService.hashToken("token-b", "user@usherbrooke.ca"));
  }
}
