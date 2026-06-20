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
}
