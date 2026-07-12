package com.moodit.core_service.repository;

import static org.assertj.core.api.Assertions.assertThat;

import com.moodit.core_service.model.AuditLog;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.test.context.TestPropertySource;

/**
 * Intégration H2 de {@link AuditLogRepositoryCustom#search} (fragment Criteria) : curseur
 * {@code beforeId}, filtre {@code type}, et recherche {@code LIKE} sur summary/auteur/details.
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:moodit_audit_it;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE;NON_KEYWORDS=ROLE,USER,VALUE",
      "spring.datasource.driver-class-name=org.h2.Driver",
      "spring.datasource.username=sa",
      "spring.datasource.password=",
      "spring.jpa.hibernate.ddl-auto=none",
      "spring.sql.init.mode=always",
      "spring.sql.init.schema-locations=classpath:test-schema.sql"
    })
class AuditLogRepositoryTest {

  @Autowired private AuditLogRepository repository;

  private AuditLog save(String action, String type, String summary, String actor, String details) {
    AuditLog l = new AuditLog();
    l.setAction(action);
    l.setEntityType(type);
    l.setSummary(summary);
    l.setActorEmail(actor);
    l.setDetails(details);
    return repository.save(l);
  }

  @Test
  void search_sansFiltre_rendLesPlusRecentesDabord() {
    save("COURSE_CREATE", "COURSE", "un", null, null);
    save("COURSE_UPDATE", "COURSE", "deux", null, null);
    save("COURSE_DELETE", "COURSE", "trois", null, null);

    List<AuditLog> page = repository.search(null, null, null, 10);

    assertThat(page).extracting(AuditLog::getSummary).containsExactly("trois", "deux", "un");
  }

  @Test
  void search_paginationParCurseur() {
    AuditLog a = save("A", "COURSE", "un", null, null);
    AuditLog b = save("B", "COURSE", "deux", null, null);
    save("C", "COURSE", "trois", null, null);

    // 1re page (taille 2) : les 2 plus récentes.
    List<AuditLog> first = repository.search(null, null, null, 2);
    assertThat(first).extracting(AuditLog::getSummary).containsExactly("trois", "deux");

    // Page suivante : curseur = id de la dernière rendue (b) → uniquement les plus anciennes.
    List<AuditLog> next = repository.search(b.getId(), null, null, 2);
    assertThat(next).extracting(AuditLog::getSummary).containsExactly("un");
    assertThat(next).extracting(AuditLog::getId).allMatch(id -> id < b.getId());
    assertThat(a.getId()).isLessThan(b.getId());
  }

  @Test
  void search_filtreParType() {
    save("ROLE_ASSIGN", "ROLE", "rôle", null, null);
    save("COURSE_UPDATE", "COURSE", "cours", null, null);

    List<AuditLog> roles = repository.search(null, "ROLE", null, 10);

    assertThat(roles).extracting(AuditLog::getEntityType).containsExactly("ROLE");
  }

  @Test
  void search_like_surResumeAuteurDetails_insensibleCasse() {
    save("COURSE_UPDATE", "COURSE", "Cours « Algo » (GIF201)", "gardien@moodit.ca", "Programmes : Génie");
    save("ROLE_ASSIGN", "ROLE", "Rôle Administrateur", "admin@moodit.ca", null);

    // résumé
    assertThat(repository.search(null, null, "%algo%", 10)).hasSize(1);
    // auteur
    assertThat(repository.search(null, null, "%admin@moodit%", 10)).hasSize(1);
    // details
    assertThat(repository.search(null, null, "%génie%", 10)).hasSize(1);
    // aucun match
    assertThat(repository.search(null, null, "%introuvable%", 10)).isEmpty();
  }

  @Test
  void search_combineTypeEtRecherche() {
    save("COURSE_UPDATE", "COURSE", "Cours Algo", null, null);
    save("QUIZ_CREATE", "QUIZ", "Quiz Algo", null, null);

    List<AuditLog> res = repository.search(null, "QUIZ", "%algo%", 10);

    assertThat(res).extracting(AuditLog::getEntityType).containsExactly("QUIZ");
  }
}
