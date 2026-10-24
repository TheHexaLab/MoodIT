package com.moodit.mcp_service.repository;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
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
    // Tables des autres agrégations (colonnes strictement utilisées par les requêtes).
    jdbc.execute("CREATE TABLE quiz (id INT PRIMARY KEY, course_id INT)");
    jdbc.execute("CREATE TABLE forum (id INT PRIMARY KEY, course_id INT)");
    jdbc.execute(
        "CREATE TABLE post (id INT PRIMARY KEY, forum_id INT, content VARCHAR(2000),"
            + " created_at TIMESTAMP)");
    jdbc.execute("CREATE TABLE attempt (id INT PRIMARY KEY, quiz_id INT, user_id INT)");
    jdbc.execute("CREATE TABLE submission (id INT PRIMARY KEY, attempt_id INT)");
    jdbc.execute("CREATE TABLE submission_test_case (submission_id INT, passed BOOLEAN)");
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

  // ── Compteurs simples ────────────────────────────────────────────────────

  @Test
  void countQuizzes_ne_compte_que_les_quiz_du_cours() {
    jdbc.update("INSERT INTO quiz VALUES (1, 100), (2, 100), (3, 200)");

    assertThat(repo.countQuizzes(100)).isEqualTo(2);
    assertThat(repo.countQuizzes(200)).isEqualTo(1);
    assertThat(repo.countQuizzes(999)).isZero();
  }

  @Test
  void countForumMessages_compte_les_posts_de_tous_les_forums_du_cours() {
    jdbc.update("INSERT INTO forum VALUES (1, 100), (2, 100), (3, 200)");
    jdbc.update("INSERT INTO post VALUES (1, 1, 'a', NULL), (2, 1, 'b', NULL)"); // forum 1 (cours 100)
    jdbc.update("INSERT INTO post VALUES (3, 2, 'c', NULL)"); // forum 2 (cours 100)
    jdbc.update("INSERT INTO post VALUES (4, 3, 'd', NULL)"); // autre cours

    assertThat(repo.countForumMessages(100)).isEqualTo(3);
    assertThat(repo.countForumMessages(200)).isEqualTo(1);
  }

  @Test
  void countQuizAttempts_et_countDistinctQuizStudents_distinguent_tentatives_et_etudiants() {
    jdbc.update("INSERT INTO quiz VALUES (1, 100), (2, 100), (3, 200)");
    // L'étudiant 10 tente deux fois (deux quiz), l'étudiant 11 une fois ; 12 sur un autre cours.
    jdbc.update("INSERT INTO attempt VALUES (1, 1, 10), (2, 2, 10), (3, 1, 11), (4, 3, 12)");

    assertThat(repo.countQuizAttempts(100)).isEqualTo(3);
    assertThat(repo.countDistinctQuizStudents(100)).isEqualTo(2);
    assertThat(repo.countQuizAttempts(300)).isZero();
    assertThat(repo.countDistinctQuizStudents(300)).isZero();
  }

  // ── Échantillon de messages ──────────────────────────────────────────────

  @Test
  void sampleForumMessages_plus_recents_d_abord_limite_et_sans_vides() {
    jdbc.update("INSERT INTO forum VALUES (1, 100), (2, 200)");
    jdbc.update("INSERT INTO post VALUES (1, 1, 'ancien', TIMESTAMP '2026-01-01 10:00:00')");
    jdbc.update("INSERT INTO post VALUES (2, 1, 'récent', TIMESTAMP '2026-03-01 10:00:00')");
    jdbc.update("INSERT INTO post VALUES (3, 1, 'milieu', TIMESTAMP '2026-02-01 10:00:00')");
    jdbc.update("INSERT INTO post VALUES (4, 1, '', TIMESTAMP '2026-04-01 10:00:00')"); // vide exclu
    jdbc.update("INSERT INTO post VALUES (5, 1, NULL, TIMESTAMP '2026-05-01 10:00:00')"); // NULL exclu
    jdbc.update("INSERT INTO post VALUES (6, 2, 'autre cours', TIMESTAMP '2026-06-01 10:00:00')");

    assertThat(repo.sampleForumMessages(100, 2)).containsExactly("récent", "milieu");
    assertThat(repo.sampleForumMessages(100, 20)).containsExactly("récent", "milieu", "ancien");
  }

  @Test
  void sampleForumMessages_tronque_chaque_message_a_400_caracteres() {
    jdbc.update("INSERT INTO forum VALUES (1, 100)");
    jdbc.update("INSERT INTO post VALUES (1, 1, ?, NULL)", "x".repeat(1000));

    List<String> sample = repo.sampleForumMessages(100, 5);

    assertThat(sample).hasSize(1);
    assertThat(sample.getFirst()).hasSize(400);
  }

  @Test
  void sampleForumMessages_vide_si_aucun_message() {
    jdbc.update("INSERT INTO forum VALUES (1, 100)");

    assertThat(repo.sampleForumMessages(100, 20)).isEmpty();
  }

  // ── Réussite au code ─────────────────────────────────────────────────────

  /** Chaîne quiz → tentative → soumission pour le cours, et retourne l'id de soumission. */
  private int submission(int id, int courseId) {
    jdbc.update("INSERT INTO quiz VALUES (?, ?)", id, courseId);
    jdbc.update("INSERT INTO attempt VALUES (?, ?, 1)", id, id);
    jdbc.update("INSERT INTO submission VALUES (?, ?)", id, id);
    return id;
  }

  @Test
  void codeTestPassRate_pourcentage_arrondi_des_cas_reussis_du_cours() {
    int s1 = submission(1, 100);
    int s2 = submission(2, 100);
    int other = submission(3, 200);
    // Cours 100 : 2 réussis sur 3 → 66,67 % → 67 (arrondi, pas troncature).
    jdbc.update("INSERT INTO submission_test_case VALUES (?, TRUE), (?, FALSE)", s1, s1);
    jdbc.update("INSERT INTO submission_test_case VALUES (?, TRUE)", s2);
    // Autre cours : uniquement des échecs, ne doit pas influencer le cours 100.
    jdbc.update("INSERT INTO submission_test_case VALUES (?, FALSE), (?, FALSE)", other, other);

    assertThat(repo.codeTestPassRate(100)).isEqualTo(67);
    assertThat(repo.codeTestPassRate(200)).isZero();
  }

  @Test
  void codeTestPassRate_cent_pourcent_si_tous_les_cas_reussis() {
    int s = submission(1, 100);
    jdbc.update("INSERT INTO submission_test_case VALUES (?, TRUE), (?, TRUE)", s, s);

    assertThat(repo.codeTestPassRate(100)).isEqualTo(100);
  }

  @Test
  void codeTestPassRate_null_si_aucun_cas_de_test_soumis() {
    // null (« non disponible ») et non 0 : un 0 % ferait croire à un échec total.
    submission(1, 100);

    assertThat(repo.codeTestPassRate(100)).isNull();
  }
}
