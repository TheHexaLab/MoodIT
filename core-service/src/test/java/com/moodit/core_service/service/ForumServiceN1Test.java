package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.moodit.core_service.dto.PostVoteUserDTO;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.FType;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.model.Post;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.Vote;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.PostRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.repository.VoteRepository;
import jakarta.persistence.EntityManagerFactory;
import java.util.ArrayList;
import java.util.List;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;

/**
 * Test ANTI-N+1 de {@link ForumService#getMessagesPage} : le nombre de requêtes SQL exécutées
 * doit être CONSTANT, indépendamment de la taille de page. S'il augmentait avec le nombre de
 * messages, ce serait un N+1. Prouve le fix (requêtes agrégées votes/childrenCount + @BatchSize
 * pour auteurs/parents).
 *
 * @DataJpaTest : couche JPA + repos sur une BD embarquée (H2), schéma généré depuis les entités.
 * ForumService est assemblé à la main (les @Service ne sont pas chargés par @DataJpaTest) ; le
 * RealtimeEventPublisher est mocké (non sollicité en lecture).
 */
@DataJpaTest
class ForumServiceN1Test {

  @Autowired private ForumRepository forumRepository;
  @Autowired private PostRepository postRepository;
  @Autowired private VoteRepository voteRepository;
  @Autowired private UserRepository userRepository;
  @Autowired private TestEntityManager em;
  @Autowired private EntityManagerFactory emf;

  private ForumService forumService;
  private Integer forumId;
  private String currentUserEmail;

  @BeforeEach
  void seed() {
    forumService =
        new ForumService(
            forumRepository,
            postRepository,
            voteRepository,
            userRepository,
            mock(RealtimeEventPublisher.class));

    FType fType = new FType();
    fType.setName("Discussion");
    em.persist(fType);

    Course course = new Course();
    course.setTitle("Cours test");
    course.setCode("TST100");
    em.persist(course);

    Forum forum = new Forum();
    forum.setTitle("Canal test");
    forum.setPosition(1);
    forum.setFType(fType);
    forum.setCourse(course);
    em.persist(forum);
    forumId = forum.getId();

    // Plusieurs auteurs (round-robin) → l'auteur des posts est chargé PAR LOTS (@BatchSize),
    // pas 1 requête/post.
    List<User> authors = new ArrayList<>();
    for (int i = 0; i < 5; i++) {
      User u = new User();
      u.setUsername("user" + i);
      u.setFirstName("Prenom" + i);
      u.setLastName("Nom" + i);
      u.setEmail("user" + i + "@test.ca");
      u.setPasswordHash("hash");
      em.persist(u);
      authors.add(u);
    }
    currentUserEmail = authors.get(0).getEmail();

    // 30 messages racines (auteurs round-robin).
    List<Post> roots = new ArrayList<>();
    for (int i = 0; i < 30; i++) {
      Post p = new Post();
      p.setForum(forum);
      p.setUser(authors.get(i % authors.size()));
      p.setContent("message " + i);
      p.setIsPinned(false);
      em.persist(p);
      roots.add(p);
    }

    // Votes sur les messages les PLUS RÉCENTS (indices 25..29) → présents dans les deux tailles
    // de page → la somme agrégée est réellement exercée.
    for (int i = 25; i < 30; i++) {
      for (User u : authors) {
        Vote v = new Vote();
        v.setPost(roots.get(i));
        v.setUser(u);
        v.setValue(1);
        em.persist(v);
      }
    }

    // Réponses rattachées au message le plus récent (index 29) → leur parent est TOUJOURS dans la
    // page (limit 10 comme 30), ce qui évite un chargement de parent hors-page qui fausserait le
    // comptage. Exerce aussi le childrenCount agrégé (le post 29 a 3 réponses).
    for (int i = 0; i < 3; i++) {
      Post reply = new Post();
      reply.setForum(forum);
      reply.setUser(authors.get(1));
      reply.setContent("réponse " + i);
      reply.setIsPinned(false);
      reply.setParent(roots.get(29));
      em.persist(reply);
    }

    em.flush();
    em.clear();
  }

  /** Nombre de requêtes JDBC exécutées par getMessagesPage pour une taille de page donnée. */
  private long queriesFor(int limit) {
    Statistics stats = emf.unwrap(SessionFactory.class).getStatistics();
    stats.setStatisticsEnabled(true);
    stats.clear();
    em.getEntityManager().clear(); // L1 vide → vraies requêtes DB (mesure représentative)

    List<PostVoteUserDTO> page = forumService.getMessagesPage(forumId, null, limit, currentUserEmail);
    assertThat(page).isNotEmpty();

    return stats.getPrepareStatementCount();
  }

  @Test
  void getMessagesPage_nombreDeRequetes_neDependPasDeLaTaille() {
    long q10 = queriesFor(10);
    long q30 = queriesFor(30);

    // Cœur du test : le compte NE DÉPEND PAS de la taille de page → aucun N+1.
    // (Avec l'ancien code, q30 aurait été nettement supérieur à q10.)
    assertThat(q30).isEqualTo(q10);

    // Borne haute : findById(forum) + findByEmail + page + 3 agrégats + auteurs/parents batchés
    // ≈ une poignée de requêtes.
    assertThat(q30).isLessThan(12);
  }
}
