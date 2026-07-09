package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Establishment;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.UserProgramRole;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.ProgramRepository;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * Test d'intégration de {@link ProgramService#deleteProgram} sur H2 (schéma test-schema.sql
 * reproduisant les ON DELETE CASCADE de la base). Vérifie que la suppression d'un programme :
 *   1. supprime les cours qui n'appartiennent qu'à lui (cours orphelins) — et leur contenu par
 *      cascade (ici les inscriptions) ;
 *   2. CONSERVE les cours partagés avec un autre programme (et leurs inscriptions) ;
 *   3. retire les liens program_course et les entrées User_Program_Role du programme (cascade BD).
 */
@DataJpaTest
@Import(ProgramService.class)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:moodit_delete_it;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE;NON_KEYWORDS=ROLE,USER,VALUE",
      "spring.datasource.driver-class-name=org.h2.Driver",
      "spring.datasource.username=sa",
      "spring.datasource.password=",
      "spring.jpa.hibernate.ddl-auto=none",
      "spring.sql.init.mode=always",
      "spring.sql.init.schema-locations=classpath:test-schema.sql"
    })
class ProgramServiceDeleteProgramIT {

  @Autowired private ProgramService programService;
  @Autowired private ProgramRepository programRepository;
  @Autowired private CourseRepository courseRepository;
  @Autowired private TestEntityManager em;

  // Le service dépend du publisher temps réel : mocké (pas de WebSocket dans un test JPA).
  @MockitoBean private RealtimeEventPublisher realtimePublisher;

  private Integer targetProgramId; // programme supprimé
  private Integer otherProgramId; // programme conservé (partage un cours avec la cible)
  private Integer sharedCourseId; // cours dans les DEUX programmes → doit survivre
  private Integer orphanCourseId; // cours seulement dans la cible → doit disparaître
  private Integer userId;

  @BeforeEach
  void seed() {
    Establishment establishment = new Establishment();
    establishment.setName("Université de test");
    establishment.setDomainEmail("test.ca");
    em.persist(establishment);

    Course shared = Course.builder().title("Cours partagé").code("SHARED").build();
    Course orphan = Course.builder().title("Cours orphelin").code("ORPHAN").build();
    em.persist(shared);
    em.persist(orphan);

    // Programme cible : contient le cours partagé ET le cours orphelin.
    Program target = Program.builder()
        .name("Programme cible").code("P1").cohort("2026").color("#0a5cc0")
        .establishment(establishment).courses(List.of(shared, orphan)).build();
    em.persist(target);

    // Autre programme : partage uniquement le cours partagé.
    Program other = Program.builder()
        .name("Autre programme").code("P2").cohort("2026").color("#0a5cc0")
        .establishment(establishment).courses(List.of(shared)).build();
    em.persist(other);

    User user = User.builder()
        .username("etudiant").firstName("Éva").lastName("Test")
        .email("eva@test.ca").passwordHash("hash").build();
    em.persist(user);

    Role role = new Role();
    role.setName("Enseignant");
    em.persist(role);

    // Rôles PAR PROGRAMME dans les deux programmes : celui de la cible doit disparaître (cascade),
    // celui de l'autre programme doit rester.
    em.persist(new UserProgramRole(target.getId(), user.getId(), role.getId()));
    em.persist(new UserProgramRole(other.getId(), user.getId(), role.getId()));

    // Inscriptions : l'étudiant est inscrit au cours orphelin (doit disparaître avec le cours)
    // et au cours partagé (doit rester, le cours survit).
    em.getEntityManager()
        .createNativeQuery("INSERT INTO enrollment (course_id, user_id) VALUES (?, ?)")
        .setParameter(1, orphan.getId())
        .setParameter(2, user.getId())
        .executeUpdate();
    em.getEntityManager()
        .createNativeQuery("INSERT INTO enrollment (course_id, user_id) VALUES (?, ?)")
        .setParameter(1, shared.getId())
        .setParameter(2, user.getId())
        .executeUpdate();

    targetProgramId = target.getId();
    otherProgramId = other.getId();
    sharedCourseId = shared.getId();
    orphanCourseId = orphan.getId();
    userId = user.getId();

    em.flush();
    em.clear();
  }

  @Test
  @DisplayName("Supprimer un programme supprime ses cours orphelins mais conserve les cours partagés")
  void deleteProgram_removesOrphanCoursesAndCascades() {
    programService.deleteProgram(targetProgramId);

    em.flush();
    em.clear();

    // 1. Le programme cible est supprimé ; l'autre programme survit.
    assertThat(programRepository.existsById(targetProgramId)).isFalse();
    assertThat(programRepository.existsById(otherProgramId)).isTrue();

    // 2. Le cours orphelin est supprimé ; le cours partagé est conservé.
    assertThat(courseRepository.existsById(orphanCourseId)).isFalse();
    assertThat(courseRepository.existsById(sharedCourseId)).isTrue();

    // 3. Plus aucun lien program_course pour le programme supprimé ; le cours partagé reste
    //    rattaché à l'autre programme.
    assertThat(countNative("SELECT count(*) FROM program_course WHERE program_id = ?", targetProgramId))
        .isZero();
    assertThat(countNative("SELECT count(*) FROM program_course WHERE course_id = ?", sharedCourseId))
        .isEqualTo(1L);

    // 4. Les entrées User_Program_Role du programme supprimé sont retirées (cascade BD) ;
    //    celles de l'autre programme restent.
    assertThat(countNative("SELECT count(*) FROM user_program_role WHERE program_id = ?", targetProgramId))
        .isZero();
    assertThat(countNative("SELECT count(*) FROM user_program_role WHERE program_id = ?", otherProgramId))
        .isEqualTo(1L);

    // 5. L'inscription au cours orphelin est emportée par la cascade ; celle au cours partagé reste.
    assertThat(countNative("SELECT count(*) FROM enrollment WHERE course_id = ?", orphanCourseId))
        .isZero();
    assertThat(countNative("SELECT count(*) FROM enrollment WHERE user_id = ?", userId))
        .isEqualTo(1L);
  }

  @Test
  @DisplayName("Un cours partagé avec plusieurs autres programmes n'est jamais supprimé")
  void deleteProgram_keepsCourseStillReferencedElsewhere() {
    programService.deleteProgram(targetProgramId);

    em.flush();
    em.clear();

    // Le cours partagé reste puisqu'il appartient encore à `otherProgram`.
    assertThat(courseRepository.existsById(sharedCourseId)).isTrue();
  }

  /** Compte via requête native (reflète l'état RÉEL en base, sans cache de 1er niveau). */
  private long countNative(String sql, Object param) {
    Number n =
        (Number)
            em.getEntityManager().createNativeQuery(sql).setParameter(1, param).getSingleResult();
    return n.longValue();
  }
}
