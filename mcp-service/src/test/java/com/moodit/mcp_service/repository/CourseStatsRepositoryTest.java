package com.moodit.mcp_service.repository;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * Vérifie la sémantique de {@link CourseStatsRepository#countStudents} : on ne compte QUE les vrais
 * étudiants (inscrits SANS rôle programme dans un programme contenant le cours). En particulier, le
 * créateur/enseignant auto-inscrit ne doit PAS gonfler le compte. H2 en mémoire (pas de contexte
 * Spring : le repo n'utilise qu'un JdbcTemplate).
 */
class CourseStatsRepositoryTest {

  private JdbcTemplate jdbc;
  private CourseStatsRepository repo;

  @BeforeEach
  void setUp() {
    // BD en mémoire UNIQUE par test (nom aléatoire) → isolation totale, y compris en parallèle.
    // DB_CLOSE_DELAY=-1 : DriverManagerDataSource ne poole pas (1 connexion/statement) ; sans ça la
    // BD mémoire serait détruite entre deux exécutions. Le nom unique évite tout partage entre tests.
    DriverManagerDataSource ds =
        new DriverManagerDataSource(
            "jdbc:h2:mem:mcp_stats_" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
    ds.setDriverClassName("org.h2.Driver");
    jdbc = new JdbcTemplate(ds);
    jdbc.execute("CREATE TABLE enrollment (user_id INT, course_id INT)");
    jdbc.execute("CREATE TABLE user_program_role (program_id INT, user_id INT, role_id INT)");
    jdbc.execute("CREATE TABLE program_course (program_id INT, course_id INT)");
    repo = new CourseStatsRepository(jdbc);
  }

  @Test
  void countStudents_exclut_le_staff_du_cours() {
    jdbc.update("INSERT INTO program_course VALUES (1, 100)"); // cours 100 ∈ programme 1
    jdbc.update("INSERT INTO enrollment VALUES (10, 100)"); // étudiant (aucun rôle)
    jdbc.update("INSERT INTO enrollment VALUES (20, 100)"); // enseignant auto-inscrit
    jdbc.update("INSERT INTO user_program_role VALUES (1, 20, 1)"); // rôle dans le programme 1 → exclu

    assertThat(repo.countStudents(100)).isEqualTo(1);
  }

  @Test
  void countStudents_compte_un_role_dans_un_autre_programme() {
    jdbc.update("INSERT INTO program_course VALUES (1, 100)");
    jdbc.update("INSERT INTO enrollment VALUES (10, 100)"); // étudiant
    jdbc.update("INSERT INTO enrollment VALUES (30, 100)"); // a un rôle, mais PAS dans le prog. du cours
    jdbc.update("INSERT INTO user_program_role VALUES (2, 30, 1)"); // programme 2 ne contient pas le cours

    assertThat(repo.countStudents(100)).isEqualTo(2);
  }

  @Test
  void countStudents_zero_si_aucune_inscription() {
    jdbc.update("INSERT INTO program_course VALUES (1, 100)");
    assertThat(repo.countStudents(100)).isEqualTo(0);
  }
}
