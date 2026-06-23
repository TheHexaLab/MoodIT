// Vérifie le routage des règles d'autorisation par scope (JdbcTemplate mocké, sans BD) :
// user → sa propre room ; program → abonnement ; channel/forum → cours via programme ;
// email inconnu / null → refus.

package com.moodit.core_service.realtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ResultSetExtractor;

class DbRoomAuthorizerTest {

  private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
  private final DbRoomAuthorizer auth = new DbRoomAuthorizer(jdbc);

  @SuppressWarnings("unchecked")
  private void stubUserId(String email, Long id) {
    lenient()
        .when(jdbc.query(contains("FROM User_"), any(ResultSetExtractor.class), eq(email)))
        .thenReturn(id);
  }

  @Test
  void user_autoriseUniquementSaPropreRoom() {
    stubUserId("a@b.ca", 5L);
    assertThat(auth.canJoin("a@b.ca", "user", 5)).isTrue();
    assertThat(auth.canJoin("a@b.ca", "user", 6)).isFalse();
  }

  @Test
  void emailInconnu_refuse() {
    stubUserId("ghost@b.ca", null);
    assertThat(auth.canJoin("ghost@b.ca", "program", 1)).isFalse();
  }

  @Test
  void emailNull_refuse() {
    assertThat(auth.canJoin(null, "user", 5)).isFalse();
  }

  @Test
  void program_verifieLAbonnement() {
    stubUserId("a@b.ca", 5L);
    when(jdbc.queryForObject(contains("User_Program"), eq(Boolean.class), eq(5L), eq(2L)))
        .thenReturn(true);
    assertThat(auth.canJoin("a@b.ca", "program", 2)).isTrue();
  }

  @Test
  void forum_verifieLeCoursViaUnProgrammeAbonne() {
    stubUserId("a@b.ca", 5L);
    when(jdbc.queryForObject(contains("FROM Forum"), eq(Boolean.class), eq(3L), eq(5L)))
        .thenReturn(true);
    assertThat(auth.canJoin("a@b.ca", "channel", 3)).isTrue();
    assertThat(auth.canJoin("a@b.ca", "forum", 3)).isTrue();
  }

  @Test
  void scopeInconnu_refuse() {
    stubUserId("a@b.ca", 5L);
    assertThat(auth.canJoin("a@b.ca", "galaxy", 1)).isFalse();
  }
}
