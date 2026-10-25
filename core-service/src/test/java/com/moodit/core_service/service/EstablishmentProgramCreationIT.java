package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.moodit.core_service.dto.ProgramCreateInEstablishmentDTO;
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.model.Establishment;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import jakarta.persistence.EntityManager;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Création d'un programme ATOMIQUE (#117) : {@link EstablishmentService#addProgramToEstablishment}
 * crée le programme et y abonne son créateur dans UNE transaction. Les services sont de vrais
 * beans Spring (leur {@code @Transactional} s'applique), et le test n'ouvre pas de transaction
 * englobante : chaque appel valide ou annule pour de bon, comme en prod.
 *
 * <p>Avant, le frontend envoyait deux requêtes ; si la seconde (abonnement) échouait, le programme
 * restait créé sans abonné, et son code devenait inutilisable (« ce code existe déjà »).
 */
@DataJpaTest
@Import({EstablishmentService.class, ProgramService.class, AuditLogService.class})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:moodit_program_creation_it;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE;NON_KEYWORDS=ROLE,USER,VALUE",
      "spring.datasource.driver-class-name=org.h2.Driver",
      "spring.datasource.username=sa",
      "spring.datasource.password=",
      "spring.jpa.hibernate.ddl-auto=none",
      "spring.sql.init.mode=always",
      "spring.sql.init.schema-locations=classpath:test-schema.sql"
    })
@Transactional(propagation = Propagation.NOT_SUPPORTED) // pas de transaction de test englobante
class EstablishmentProgramCreationIT {

  private static final String CREATOR = "createur@test.ca";

  @Autowired private EstablishmentService establishmentService;
  @Autowired private EntityManager em;
  @Autowired private PlatformTransactionManager transactionManager;
  @Autowired private DataSource dataSource;

  // L'abonnement passe par le VRAI ProgramService ; l'espion permet de le faire échouer.
  @MockitoSpyBean private ProgramService programService;
  // Pas de WebSocket dans un test JPA : les diffusions (après commit) sont observées sur le mock.
  @MockitoBean private RealtimeEventPublisher realtimePublisher;

  private JdbcTemplate jdbc;
  private Integer establishmentId;
  private Integer creatorId;

  @BeforeEach
  void seed() {
    jdbc = new JdbcTemplate(dataSource);
    jdbc.update("DELETE FROM user_program");
    jdbc.update("DELETE FROM program");
    jdbc.update("DELETE FROM user_");
    jdbc.update("DELETE FROM establishment");
    new TransactionTemplate(transactionManager)
        .executeWithoutResult(
            status -> {
              Establishment est = new Establishment();
              est.setName("Université de test");
              est.setDomainEmail("test.ca");
              em.persist(est);
              User creator =
                  User.builder()
                      .username("createur")
                      .firstName("Ada")
                      .lastName("Test")
                      .email(CREATOR)
                      .passwordHash("hash")
                      .build();
              em.persist(creator);
              establishmentId = est.getId();
              creatorId = creator.getId();
            });
  }

  private ProgramCreateInEstablishmentDTO newProgram(String code) {
    return ProgramCreateInEstablishmentDTO.builder()
        .establishmentId(establishmentId)
        .name("Génie logiciel")
        .code(code)
        .cohort("2026")
        .color("#123456")
        .build();
  }

  private int programsWithCode(String code) {
    return jdbc.queryForObject("SELECT COUNT(*) FROM program WHERE code = ?", Integer.class, code);
  }

  private int subscriptionsOfCreator() {
    return jdbc.queryForObject(
        "SELECT COUNT(*) FROM user_program WHERE user_id = ?", Integer.class, creatorId);
  }

  @Test
  @DisplayName("Succès : programme créé ET créateur abonné, diffusions envoyées après le commit")
  void succes_programme_et_abonnement() {
    ProgramDTO created = establishmentService.addProgramToEstablishment(newProgram("GLO"), CREATOR);

    assertThat(programsWithCode("GLO")).isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM user_program WHERE user_id = ? AND program_id = ?",
                Integer.class,
                creatorId,
                created.getId()))
        .isEqualTo(1);
    // Barre latérale du créateur (room user:<id>) et catalogue de l'établissement, après commit.
    verify(realtimePublisher).subscriptionAdded(eq((long) creatorId), any());
    verify(realtimePublisher).establishmentUpdated(eq((long) establishmentId), any());
  }

  @Test
  @DisplayName("Abonnement en échec : AUCUN programme créé, aucune diffusion, le code reste libre")
  void echec_abonnement_rien_n_est_cree() {
    doThrow(new IllegalStateException("abonnement impossible"))
        .when(programService)
        .addUserToPrograms(any());

    assertThatThrownBy(
            () -> establishmentService.addProgramToEstablishment(newProgram("GLO"), CREATOR))
        .hasMessage("abonnement impossible");

    assertThat(programsWithCode("GLO")).isZero();
    assertThat(subscriptionsOfCreator()).isZero();
    verify(realtimePublisher, never()).establishmentUpdated(anyLong(), any());
    verify(realtimePublisher, never()).subscriptionAdded(anyLong(), any());
  }

  @Test
  @DisplayName("Créateur inconnu : aucun programme créé")
  void createur_inconnu() {
    assertThatThrownBy(
            () -> establishmentService.addProgramToEstablishment(newProgram("GLO"), "inconnu@test.ca"))
        .isInstanceOf(com.moodit.core_service.exception.UserNotFoundException.class);
    assertThat(programsWithCode("GLO")).isZero();
  }
}
