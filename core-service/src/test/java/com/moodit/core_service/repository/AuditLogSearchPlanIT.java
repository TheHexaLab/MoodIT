package com.moodit.core_service.repository;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.sql.Connection;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.FileSystemResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * GARDE DE NON-RÉGRESSION du plan de recherche du journal, sur un VRAI Postgres (Testcontainers).
 *
 * <p>Les tests de correction ({@code AuditLogRepositoryTest}) tournent sur H2, qui n'a ni {@code
 * pg_trgm} ni ce plan : ils resteraient VERTS même si le fence {@code OFFSET 0} disparaissait, et on
 * repartirait silencieusement en seq scan. Cet IT ferme ce trou : il EXPLAINe la requête RÉELLE
 * produite par {@link AuditLogRepositoryCustomImpl#buildSearchSql} et exige un {@code Bitmap Index
 * Scan} sur un index GIN trigram. Retirer le fence ⇒ plan différent ⇒ ce test casse.
 *
 * <p>Bonus : charge la MIGRATION prod ({@code migrations/…audit_log.sql}) → prouve aussi que son DDL
 * (table + pg_trgm + index) est valide sur Postgres.
 */
@Tag("integration")
@Testcontainers
class AuditLogSearchPlanIT {

  @Container
  private static final PostgreSQLContainer<?> POSTGRES =
      new PostgreSQLContainer<>("postgres:16");

  private static JdbcTemplate jdbc;

  @BeforeAll
  static void setUp() throws Exception {
    DriverManagerDataSource ds =
        new DriverManagerDataSource(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    ds.setDriverClassName("org.postgresql.Driver");
    jdbc = new JdbcTemplate(ds);

    // Schéma = la migration prod (single source of truth ; en valide aussi le DDL sur Postgres).
    try (Connection c = ds.getConnection()) {
      ScriptUtils.executeSqlScript(
          c, new FileSystemResource(Path.of("..", "migrations", "2026-07-12_audit_log.sql")));
    }

    // 50 000 lignes ; un token rare ('zqxjw') dans ~4 lignes → recherche sélective (cas où l'index
    // GIN trigram doit être choisi une fois le fence en place).
    jdbc.update(
        "INSERT INTO audit_log (action, entity_type, entity_id, summary, actor_email, details) "
            + "SELECT 'COURSE_UPDATE','COURSE',g,'Cours numero '||g||' mis a jour',"
            + "'user'||(g%500)||'@moodit.ca','Programmes : P'||(g%50) "
            + "FROM generate_series(1,50000) g");
    jdbc.update("UPDATE audit_log SET summary='Cours zqxjw special' WHERE id % 12345 = 0");
    // VACUUM ANALYZE : flush la pending list GIN + met à jour les stats → plan déterministe
    // (avec fastupdate=off c'est déjà le cas, mais on garantit indépendamment de la config).
    jdbc.execute("VACUUM ANALYZE audit_log");
  }

  /** La requête réelle (avec fence OFFSET 0) doit passer par le bitmap OR des index GIN trigram. */
  @Test
  void search_utilise_les_index_trigram() {
    String sql =
        AuditLogRepositoryCustomImpl.buildSearchSql(null, null, 30).replace(":like", "'%zqxjw%'");

    String plan = String.join("\n", jdbc.queryForList("EXPLAIN " + sql, String.class));

    assertThat(plan)
        .as("le plan doit utiliser le bitmap index scan trigram (fence OFFSET 0)\n%s", plan)
        .contains("Bitmap Index Scan")
        .contains("trgm");
    assertThat(plan).doesNotContain("Seq Scan on audit_log");
  }

  /** Et elle reste CORRECTE sur Postgres (le token rare est bien retrouvé). */
  @Test
  void search_retourne_les_bonnes_lignes_sur_postgres() {
    String sql =
        AuditLogRepositoryCustomImpl.buildSearchSql(null, null, 30).replace(":like", "'%zqxjw%'");

    List<Map<String, Object>> rows = jdbc.queryForList(sql);

    assertThat(rows).isNotEmpty();
    assertThat(rows).allSatisfy(r -> assertThat(r.get("summary").toString()).contains("zqxjw"));
  }
}
