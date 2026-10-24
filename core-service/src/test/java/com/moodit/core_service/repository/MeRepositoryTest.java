package com.moodit.core_service.repository;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.MeDto;
import com.moodit.core_service.dto.Role;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/**
 * {@link MeRepository} sans base : le {@link JdbcTemplate} est remplacé par un double qui
 * enregistre les paramètres et applique le {@link RowMapper} du dépôt à un {@link ResultSet}
 * simulé. On vérifie le mapping des colonnes, l'ORDRE des paramètres et l'assemblage des rôles
 * (chargés avec l'id du profil, pas chargés si le compte n'existe pas). Le SQL lui-même
 * ({@code UPDATE … RETURNING}, propre à Postgres) est exécuté pour de vrai dans {@link
 * MeRepositoryIT} (Testcontainers).
 */
class MeRepositoryTest {

    /** JdbcTemplate factice : renvoie le profil puis les rôles selon la requête reçue. */
    private static final class FakeJdbc extends JdbcTemplate {
        final List<String> sqls = new ArrayList<>();
        final List<Object[]> params = new ArrayList<>();
        boolean userExists = true;

        @Override
        public <T> List<T> query(String sql, RowMapper<T> rowMapper, Object... args) {
            sqls.add(sql);
            params.add(args);
            try {
                if (sql.contains("FROM Role")) {
                    return List.of(rowMapper.mapRow(roleRow(1, "Administrateur"), 0),
                            rowMapper.mapRow(roleRow(4, "Gardien"), 1));
                }
                return userExists ? List.of(rowMapper.mapRow(userRow(), 0)) : List.of();
            } catch (SQLException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    private static ResultSet userRow() throws SQLException {
        ResultSet rs = mock(ResultSet.class);
        when(rs.getLong("id")).thenReturn(12L);
        when(rs.getString("username")).thenReturn("rosie");
        when(rs.getString("first_name")).thenReturn("Rosie");
        when(rs.getString("last_name")).thenReturn("Tremblay");
        when(rs.getString("email")).thenReturn("rosie@test.ca");
        when(rs.getString("avatar_color")).thenReturn("#0a5cc0");
        when(rs.getString("settings")).thenReturn("{\"theme\":\"dark\"}");
        return rs;
    }

    private static ResultSet roleRow(long id, String name) throws SQLException {
        ResultSet rs = mock(ResultSet.class);
        when(rs.getLong("id")).thenReturn(id);
        when(rs.getString("name")).thenReturn(name);
        return rs;
    }

    private FakeJdbc jdbc;
    private MeRepository repository;

    @BeforeEach
    void setUp() {
        jdbc = new FakeJdbc();
        repository = new MeRepository(jdbc);
    }

    private static void assertRosie(MeDto me) {
        assertThat(me.id()).isEqualTo(12L);
        assertThat(me.username()).isEqualTo("rosie");
        assertThat(me.firstName()).isEqualTo("Rosie");
        assertThat(me.lastName()).isEqualTo("Tremblay");
        assertThat(me.email()).isEqualTo("rosie@test.ca");
        assertThat(me.avatarColor()).isEqualTo("#0a5cc0");
        assertThat(me.settings()).isEqualTo("{\"theme\":\"dark\"}");
        assertThat(me.roles()).containsExactly(new Role(1, "Administrateur"), new Role(4, "Gardien"));
    }

    @Test
    @DisplayName("findByEmail : profil mappé + rôles globaux chargés par l'id de l'utilisateur")
    void findByEmail_profilEtRoles() {
        Optional<MeDto> me = repository.findByEmail("rosie@test.ca");

        assertThat(me).isPresent();
        assertRosie(me.get());
        assertThat(jdbc.sqls).hasSize(2);
        assertThat(jdbc.params.get(0)).containsExactly("rosie@test.ca");
        // Les rôles sont chargés avec l'id LU dans la ligne du profil (et non l'email).
        assertThat(jdbc.params.get(1)).containsExactly(12L);
    }

    @Test
    @DisplayName("findByEmail : aucun compte → vide, rôles non chargés")
    void findByEmail_inconnu_vide() {
        jdbc.userExists = false;

        assertThat(repository.findByEmail("ghost@test.ca")).isEmpty();
        assertThat(jdbc.sqls).hasSize(1);
    }

    @Test
    @DisplayName("updateByEmail : paramètres prénom, nom, couleur puis email ; rôles rattachés")
    void updateByEmail_parametresDansLOrdre() {
        Optional<MeDto> me = repository.updateByEmail("rosie@test.ca", "Rosie", "Tremblay", "#0a5cc0");

        assertThat(me).isPresent();
        assertRosie(me.get());
        assertThat(jdbc.params.get(0)).containsExactly("Rosie", "Tremblay", "#0a5cc0", "rosie@test.ca");
    }

    @Test
    @DisplayName("updateByEmail : aucun compte → vide")
    void updateByEmail_inconnu_vide() {
        jdbc.userExists = false;

        assertThat(repository.updateByEmail("ghost@test.ca", "a", "b", "#000000")).isEmpty();
        assertThat(jdbc.sqls).hasSize(1);
    }

    @Test
    @DisplayName("updateSettingsByEmail : écrase la colonne settings avec le JSON fourni")
    void updateSettingsByEmail_ecraseLeBlob() {
        Optional<MeDto> me = repository.updateSettingsByEmail("rosie@test.ca", "{\"theme\":\"dark\"}");

        assertThat(me).isPresent();
        assertRosie(me.get());
        assertThat(jdbc.params.get(0)).containsExactly("{\"theme\":\"dark\"}", "rosie@test.ca");
    }

    @Test
    @DisplayName("updateSettingsByEmail : aucun compte → vide")
    void updateSettingsByEmail_inconnu_vide() {
        jdbc.userExists = false;

        assertThat(repository.updateSettingsByEmail("ghost@test.ca", "{}")).isEmpty();
        assertThat(jdbc.sqls).hasSize(1);
    }
}
