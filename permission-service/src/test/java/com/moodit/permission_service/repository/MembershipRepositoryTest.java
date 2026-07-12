package com.moodit.permission_service.repository;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.jdbc.Sql;

/**
 * Teste les requêtes SQL natives de {@link MembershipRepository} contre une VRAIE base
 * (H2 en mode PostgreSQL), pas des mocks : on valide les JOINs, conditions et noms de
 * tables/colonnes (calqués sur init.sql). Attrape les fautes de frappe SQL et les jointures
 * erronées qu'un test mocké ne verrait pas. Schéma recréé avant chaque test (@Sql), données
 * insérées dans la transaction du test (rollback automatique).
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:permtest;MODE=PostgreSQL;NON_KEYWORDS=ROLE,VALUE;DB_CLOSE_DELAY=-1",
      "spring.datasource.driver-class-name=org.h2.Driver",
      "spring.datasource.username=sa",
      "spring.datasource.password=",
      // Surcharge le ddl-auto=validate du profil prod : on gère le schéma via @Sql.
      "spring.jpa.hibernate.ddl-auto=none"
    })
@Sql(scripts = "/membership-schema.sql")
class MembershipRepositoryTest {

  @Autowired private MembershipRepository repo;
  @Autowired private TestEntityManager tem;

  /** Exécute un INSERT/DDL brut dans la transaction du test. */
  private void sql(String statement) {
    tem.getEntityManager().createNativeQuery(statement).executeUpdate();
  }

  // ── Rôles globaux ────────────────────────────────────────────────────────────────────

  @Test
  void hasGlobalRole_trueWhenGlobalAssignableRole() {
    sql("INSERT INTO role(id,name,global_assignable) VALUES (1,'Gardien',TRUE)");
    sql("INSERT INTO user_role(user_id,role_id) VALUES (5,1)");
    assertThat(repo.hasGlobalRole(5)).isTrue();
  }

  @Test
  void hasGlobalRole_falseWhenRoleNotGlobal() {
    sql("INSERT INTO role(id,name,global_assignable) VALUES (2,'Enseignant',FALSE)");
    sql("INSERT INTO user_role(user_id,role_id) VALUES (5,2)");
    assertThat(repo.hasGlobalRole(5)).isFalse();
  }

  @Test
  void hasGlobalRole_falseWhenNoRole() {
    assertThat(repo.hasGlobalRole(5)).isFalse();
  }

  @Test
  void findRoleNameById_returnsName() {
    sql("INSERT INTO role(id,name,global_assignable) VALUES (2,'Administrateur',TRUE)");
    assertThat(repo.findRoleNameById(2)).isEqualTo("Administrateur");
  }

  @Test
  void findRoleNameById_unknown_null() {
    assertThat(repo.findRoleNameById(99)).isNull();
  }

  // ── Rôles PROGRAMME ────────────────────────────────────────────────────────────────────

  @Test
  void hasRoleInProgram_true() {
    sql("INSERT INTO role(id,name) VALUES (3,'Administrateur')");
    sql("INSERT INTO user_program_role(program_id,user_id,role_id) VALUES (7,5,3)");
    assertThat(repo.hasRoleInProgram(5, 7, "Administrateur")).isTrue();
  }

  @Test
  void hasRoleInProgram_wrongProgram_false() {
    sql("INSERT INTO role(id,name) VALUES (3,'Administrateur')");
    sql("INSERT INTO user_program_role(program_id,user_id,role_id) VALUES (7,5,3)");
    assertThat(repo.hasRoleInProgram(5, 8, "Administrateur")).isFalse();
  }

  @Test
  void hasRoleInAnyProgram_true() {
    sql("INSERT INTO role(id,name) VALUES (3,'Administrateur')");
    sql("INSERT INTO user_program_role(program_id,user_id,role_id) VALUES (7,5,3)");
    assertThat(repo.hasRoleInAnyProgram(5, "Administrateur")).isTrue();
  }

  @Test
  void hasRoleInAnyProgram_onlyOtherRole_false() {
    sql("INSERT INTO role(id,name) VALUES (4,'Enseignant')");
    sql("INSERT INTO user_program_role(program_id,user_id,role_id) VALUES (7,5,4)");
    assertThat(repo.hasRoleInAnyProgram(5, "Administrateur")).isFalse();
  }

  // ── Rôle sur un COURS / QUIZ / FORUM / ANALYSE (résolution via program_course) ─────────

  @Test
  void hasRoleInCourse_true() {
    seedTeacherOfCourse(5, 7, 1);
    assertThat(repo.hasRoleInCourse(5, 1, "Enseignant")).isTrue();
  }

  @Test
  void hasRoleInCourse_courseNotInProgram_false() {
    seedTeacherOfCourse(5, 7, 1);
    assertThat(repo.hasRoleInCourse(5, 2, "Enseignant")).isFalse();
  }

  @Test
  void hasRoleInQuizCourse_true() {
    seedTeacherOfCourse(5, 7, 1);
    sql("INSERT INTO quiz(id,course_id) VALUES (30,1)");
    assertThat(repo.hasRoleInQuizCourse(5, 30, "Enseignant")).isTrue();
  }

  @Test
  void hasRoleInForumCourse_true() {
    seedTeacherOfCourse(5, 7, 1);
    sql("INSERT INTO forum(id,course_id) VALUES (9,1)");
    assertThat(repo.hasRoleInForumCourse(5, 9, "Enseignant")).isTrue();
  }

  @Test
  void hasRoleInForumCourse_notManager_false() {
    // Forum d'un cours d'un programme où l'utilisateur n'a AUCUN rôle → false.
    sql("INSERT INTO role(id,name) VALUES (4,'Enseignant')");
    sql("INSERT INTO program_course(program_id,course_id) VALUES (7,1)");
    sql("INSERT INTO forum(id,course_id) VALUES (9,1)");
    assertThat(repo.hasRoleInForumCourse(5, 9, "Enseignant")).isFalse();
  }

  @Test
  void hasRoleInAnalysisCourse_true() {
    seedTeacherOfCourse(5, 7, 1);
    sql("INSERT INTO mcp_response(id,user_id,course_id) VALUES (50,99,1)");
    assertThat(repo.hasRoleInAnalysisCourse(5, 50, "Enseignant")).isTrue();
  }

  /** Rend l'utilisateur Enseignant d'un cours : rôle dans le programme + cours rattaché. */
  private void seedTeacherOfCourse(int userId, int programId, int courseId) {
    sql("INSERT INTO role(id,name) VALUES (4,'Enseignant')");
    sql(
        "INSERT INTO user_program_role(program_id,user_id,role_id) VALUES ("
            + programId
            + ","
            + userId
            + ",4)");
    sql("INSERT INTO program_course(program_id,course_id) VALUES (" + programId + "," + courseId + ")");
  }

  // ── Abonnement / structure (appartenance) ─────────────────────────────────────────────

  @Test
  void isSubscribedToProgram_trueAndFalse() {
    sql("INSERT INTO user_program(program_id,user_id) VALUES (7,5)");
    assertThat(repo.isSubscribedToProgram(5, 7)).isTrue();
    assertThat(repo.isSubscribedToProgram(5, 8)).isFalse();
  }

  @Test
  void isCourseInProgram_trueAndFalse() {
    sql("INSERT INTO program_course(program_id,course_id) VALUES (7,1)");
    assertThat(repo.isCourseInProgram(1, 7)).isTrue();
    assertThat(repo.isCourseInProgram(1, 8)).isFalse();
  }

  @Test
  void canSeeForumViaProgram_true() {
    sql("INSERT INTO forum(id,course_id) VALUES (9,1)");
    sql("INSERT INTO program_course(program_id,course_id) VALUES (7,1)");
    sql("INSERT INTO user_program(program_id,user_id) VALUES (7,5)");
    assertThat(repo.canSeeForumViaProgram(5, 9)).isTrue();
  }

  @Test
  void canSeeForumViaProgram_notSubscribed_false() {
    sql("INSERT INTO forum(id,course_id) VALUES (9,1)");
    sql("INSERT INTO program_course(program_id,course_id) VALUES (7,1)");
    assertThat(repo.canSeeForumViaProgram(5, 9)).isFalse();
  }

  @Test
  void canSeeCourseViaProgram_true() {
    sql("INSERT INTO program_course(program_id,course_id) VALUES (7,1)");
    sql("INSERT INTO user_program(program_id,user_id) VALUES (7,5)");
    assertThat(repo.canSeeCourseViaProgram(5, 1)).isTrue();
  }

  @Test
  void canSeeQuizViaProgram_true() {
    sql("INSERT INTO quiz(id,course_id) VALUES (30,1)");
    sql("INSERT INTO program_course(program_id,course_id) VALUES (7,1)");
    sql("INSERT INTO user_program(program_id,user_id) VALUES (7,5)");
    assertThat(repo.canSeeQuizViaProgram(5, 30)).isTrue();
  }

  @Test
  void isEnrolledInCourse_true() {
    sql("INSERT INTO enrollment(id,course_id,user_id) VALUES (1,1,5)");
    assertThat(repo.isEnrolledInCourse(5, 1)).isTrue();
  }

  // ── Propriété d'un post / vote ─────────────────────────────────────────────────────────

  @Test
  void isPostAuthor_trueAndOtherFalse() {
    sql("INSERT INTO post(id,forum_id,user_id,post_parent_id) VALUES (40,9,5,NULL)");
    assertThat(repo.isPostAuthor(5, 40)).isTrue();
    assertThat(repo.isPostAuthor(99, 40)).isFalse();
  }

  @Test
  void isVoteOwner_trueAndOtherFalse() {
    sql("INSERT INTO vote(id,user_id,post_id,quiz_id) VALUES (60,5,40,NULL)");
    assertThat(repo.isVoteOwner(5, 60)).isTrue();
    assertThat(repo.isVoteOwner(99, 60)).isFalse();
  }
}
