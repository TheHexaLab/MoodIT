package com.moodit.core_service.repository;

import static org.assertj.core.api.Assertions.assertThat;

import com.moodit.core_service.dto.MeDto;
import com.moodit.core_service.dto.Role;
import java.nio.file.Path;
import java.util.Optional;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.MountableFile;

/**
 * {@link MeRepository} contre un VRAI Postgres (Testcontainers), schéma et données de référence
 * chargés depuis les migrations Flyway ({@code db/migration}, V1 et V2). Les requêtes {@code UPDATE … RETURNING} ne tournent pas sur H2 : seul ce test prouve
 * qu'elles sont valides, qu'elles modifient la BONNE ligne (et seulement elle), que les colonnes
 * renvoyées sont bien mappées et que les rôles globaux (User_Role) sont rattachés au profil.
 */
@Tag("integration")
@Testcontainers
class MeRepositoryIT {

  // Les migrations sont montées dans docker-entrypoint-initdb.d : exécutées par psql (ON_ERROR_STOP),
  // qui comprend les chaînes $sc$…$sc$ des langages (ScriptUtils, non).
  @Container
  private static final PostgreSQLContainer<?> POSTGRES =
      new PostgreSQLContainer<>("postgres:16")
          // Préfixes 01-/02- : docker-entrypoint exécute les fichiers par ordre alphabétique.
          .withCopyFileToContainer(
              MountableFile.forHostPath(Path.of("..", "db", "migration", "V1__schema.sql")),
              "/docker-entrypoint-initdb.d/01-V1__schema.sql")
          .withCopyFileToContainer(
              MountableFile.forHostPath(Path.of("..", "db", "migration", "V2__donnees_reference.sql")),
              "/docker-entrypoint-initdb.d/02-V2__donnees_reference.sql");

  private static JdbcTemplate jdbc;
  private static MeRepository repository;

  private static final String EMAIL = "eva.it@test.ca";
  private static final String OTHER_EMAIL = "zoe.it@test.ca";

  private long evaId;
  private long adminRoleId;
  private long gardienRoleId;

  @BeforeAll
  static void connect() {
    DriverManagerDataSource ds =
        new DriverManagerDataSource(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    ds.setDriverClassName("org.postgresql.Driver");
    jdbc = new JdbcTemplate(ds);
    repository = new MeRepository(jdbc);
  }

  @BeforeEach
  void seed() {
    jdbc.update("DELETE FROM User_ WHERE email IN (?, ?)", EMAIL, OTHER_EMAIL);
    evaId =
        jdbc.queryForObject(
            "INSERT INTO User_ (username, first_name, last_name, email, password_hash, avatar_color,"
                + " settings) VALUES ('eva_it', 'Éva', 'Test', ?, 'h', '#112233', '{\"theme\":\"light\"}')"
                + " RETURNING id",
            Long.class,
            EMAIL);
    jdbc.update(
        "INSERT INTO User_ (username, first_name, last_name, email, password_hash)"
            + " VALUES ('zoe_it', 'Zoé', 'Autre', ?, 'h')",
        OTHER_EMAIL);
    adminRoleId = jdbc.queryForObject("SELECT id FROM Role WHERE name = 'Administrateur'", Long.class);
    gardienRoleId = jdbc.queryForObject("SELECT id FROM Role WHERE name = 'Gardien'", Long.class);
    // Insérés dans le désordre : le dépôt doit les renvoyer triés par id.
    jdbc.update("INSERT INTO User_Role (user_id, role_id) VALUES (?, ?)", evaId, gardienRoleId);
    jdbc.update("INSERT INTO User_Role (user_id, role_id) VALUES (?, ?)", evaId, adminRoleId);
  }

  private String column(String col, String email) {
    return jdbc.queryForObject("SELECT " + col + " FROM User_ WHERE email = ?", String.class, email);
  }

  @Test
  @DisplayName("findByEmail : profil complet et rôles globaux triés par id")
  void findByEmail_profilEtRoles() {
    MeDto me = repository.findByEmail(EMAIL).orElseThrow();

    assertThat(me.id()).isEqualTo(evaId);
    assertThat(me.username()).isEqualTo("eva_it");
    assertThat(me.firstName()).isEqualTo("Éva");
    assertThat(me.lastName()).isEqualTo("Test");
    assertThat(me.email()).isEqualTo(EMAIL);
    assertThat(me.avatarColor()).isEqualTo("#112233");
    assertThat(me.settings()).isEqualTo("{\"theme\":\"light\"}");
    // V2 crée Administrateur avant Gardien : le tri par id doit les rendre dans cet ordre,
    // alors qu'ils ont été insérés dans User_Role dans l'ordre inverse.
    assertThat(adminRoleId).isLessThan(gardienRoleId);
    assertThat(me.roles())
        .containsExactly(new Role(adminRoleId, "Administrateur"), new Role(gardienRoleId, "Gardien"));
  }

  @Test
  @DisplayName("findByEmail : utilisateur sans rôle global → liste de rôles vide ; inconnu → vide")
  void findByEmail_sansRole_etInconnu() {
    assertThat(repository.findByEmail(OTHER_EMAIL).orElseThrow().roles()).isEmpty();
    assertThat(repository.findByEmail("ghost@test.ca")).isEmpty();
  }

  @Test
  @DisplayName("updateByEmail : UPDATE … RETURNING modifie la ligne et renvoie le profil à jour")
  void updateByEmail_modifieEtRenvoie() {
    Optional<MeDto> me = repository.updateByEmail(EMAIL, "Évangéline", "Nouveau", "#abcdef");

    assertThat(me).isPresent();
    assertThat(me.get().id()).isEqualTo(evaId);
    assertThat(me.get().firstName()).isEqualTo("Évangéline");
    assertThat(me.get().lastName()).isEqualTo("Nouveau");
    assertThat(me.get().avatarColor()).isEqualTo("#abcdef");
    // Colonnes non modifiées renvoyées telles quelles par RETURNING.
    assertThat(me.get().username()).isEqualTo("eva_it");
    assertThat(me.get().settings()).isEqualTo("{\"theme\":\"light\"}");
    assertThat(me.get().roles()).hasSize(2);
    // Persisté en base…
    assertThat(column("first_name", EMAIL)).isEqualTo("Évangéline");
    assertThat(column("avatar_color", EMAIL)).isEqualTo("#abcdef");
    // …et l'autre compte n'est pas touché.
    assertThat(column("first_name", OTHER_EMAIL)).isEqualTo("Zoé");
    assertThat(column("avatar_color", OTHER_EMAIL)).isEqualTo("#0a5cc0");
  }

  @Test
  @DisplayName("updateByEmail : email inconnu → vide, aucune ligne modifiée")
  void updateByEmail_inconnu_vide() {
    assertThat(repository.updateByEmail("ghost@test.ca", "a", "b", "#000000")).isEmpty();

    assertThat(column("first_name", EMAIL)).isEqualTo("Éva");
    assertThat(column("first_name", OTHER_EMAIL)).isEqualTo("Zoé");
  }

  @Test
  @DisplayName("updateSettingsByEmail : écrase le blob settings du seul compte visé")
  void updateSettingsByEmail_ecraseLeBlob() {
    MeDto me = repository.updateSettingsByEmail(EMAIL, "{\"theme\":\"dark\"}").orElseThrow();

    assertThat(me.settings()).isEqualTo("{\"theme\":\"dark\"}");
    assertThat(me.firstName()).isEqualTo("Éva");
    assertThat(me.roles()).extracting(Role::name).containsExactlyInAnyOrder("Administrateur", "Gardien");
    assertThat(column("settings", EMAIL)).isEqualTo("{\"theme\":\"dark\"}");
    assertThat(column("settings", OTHER_EMAIL)).isNull();
  }

  @Test
  @DisplayName("updateSettingsByEmail : email inconnu → vide")
  void updateSettingsByEmail_inconnu_vide() {
    assertThat(repository.updateSettingsByEmail("ghost@test.ca", "{}")).isEmpty();
    assertThat(column("settings", EMAIL)).isEqualTo("{\"theme\":\"light\"}");
  }
}
