package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.moodit.core_service.dto.VoteCreateInPostDTO;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.FType;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.model.Post;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.PostRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.repository.VoteRepository;
import jakarta.persistence.EntityManager;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.MountableFile;

/**
 * Votes SIMULTANÉS d'un même utilisateur sur un même post (#130), contre un VRAI Postgres
 * (Testcontainers, schéma {@code init.sql}). H2 ne reproduit ni la contrainte UNIQUE sous
 * concurrence ni le verrou de ligne : seul ce test prouve que {@link ForumService#addVoteToPost}
 * sérialise les votes. Avant le verrou, deux transactions lisaient « aucun vote » en même temps,
 * puis inséraient chacune le leur : l'une échouait sur UNIQUE(user_id, post_id) (409 côté API).
 *
 * <p>Chaque vote tourne dans SA transaction (comme le proxy {@code @Transactional} en prod), sur
 * deux threads relâchés ensemble par une barrière, plusieurs tours de suite pour multiplier les
 * collisions.
 */
@Tag("integration")
@Testcontainers
@DataJpaTest(properties = "spring.jpa.hibernate.ddl-auto=none")
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Transactional(propagation = Propagation.NOT_SUPPORTED) // pas de transaction de test englobante
class ForumVoteConcurrencyIT {

  @Container
  private static final PostgreSQLContainer<?> POSTGRES =
      new PostgreSQLContainer<>("postgres:16")
          .withCopyFileToContainer(
              MountableFile.forHostPath(Path.of("..", "init.sql")),
              "/docker-entrypoint-initdb.d/init.sql");

  @DynamicPropertySource
  static void datasource(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
    registry.add("spring.datasource.username", POSTGRES::getUsername);
    registry.add("spring.datasource.password", POSTGRES::getPassword);
  }

  private static final int ROUNDS = 25;

  @Autowired private ForumRepository forumRepository;
  @Autowired private PostRepository postRepository;
  @Autowired private VoteRepository voteRepository;
  @Autowired private UserRepository userRepository;
  @Autowired private EntityManager em;
  @Autowired private PlatformTransactionManager transactionManager;
  @Autowired private javax.sql.DataSource dataSource;

  private ForumService forumService;
  private TransactionTemplate tx;
  private JdbcTemplate jdbc;
  private ExecutorService pool;
  private int forumId;
  private int postId;
  private int userId;
  private final String email = "vote.it@test.ca";

  @BeforeEach
  void seed() {
    forumService =
        new ForumService(
            forumRepository,
            postRepository,
            voteRepository,
            userRepository,
            mock(RealtimeEventPublisher.class),
            mock(AuditLogService.class));
    tx = new TransactionTemplate(transactionManager);
    jdbc = new JdbcTemplate(dataSource);
    pool = Executors.newFixedThreadPool(2);

    // Utilisateur inséré en SQL : l'entité User envoie created_at = NULL, que la colonne refuse
    // (NOT NULL DEFAULT now()) ; seul le défaut de la BD le renseigne.
    userId =
        jdbc.queryForObject(
            "INSERT INTO User_ (username, first_name, last_name, email, password_hash)"
                + " VALUES ('vote_it', 'Vote', 'IT', ?, 'hash') RETURNING id",
            Integer.class,
            email);

    tx.executeWithoutResult(
        status -> {
          FType fType = new FType();
          fType.setName("Discussion-it-" + System.nanoTime());
          em.persist(fType);
          Course course = new Course();
          course.setTitle("Cours vote IT");
          course.setCode("VIT" + (System.nanoTime() % 100000));
          em.persist(course);
          Forum forum = new Forum();
          forum.setTitle("Canal vote IT");
          forum.setPosition(1);
          forum.setFType(fType);
          forum.setCourse(course);
          em.persist(forum);
          User user = em.find(User.class, userId);
          Post post = new Post();
          post.setForum(forum);
          post.setUser(user);
          post.setContent("sujet");
          post.setIsPinned(false);
          em.persist(post);
          forumId = forum.getId();
          postId = post.getId();
        });
  }

  @AfterEach
  void cleanup() {
    pool.shutdownNow();
    jdbc.update("DELETE FROM Vote WHERE user_id = ?", userId);
    jdbc.update("DELETE FROM Post WHERE id = ?", postId);
    jdbc.update("DELETE FROM User_ WHERE id = ?", userId);
  }

  private VoteCreateInPostDTO vote(int value) {
    return VoteCreateInPostDTO.builder().forumId(forumId).postId(postId).voteValue(value).build();
  }

  /** Lance les deux votes en même temps, chacun dans sa transaction ; rend les erreurs levées. */
  private List<Throwable> concurrently(int first, int second) throws Exception {
    CyclicBarrier start = new CyclicBarrier(2);
    List<Future<?>> futures = new ArrayList<>();
    for (int value : new int[] {first, second}) {
      futures.add(
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                tx.executeWithoutResult(s -> forumService.addVoteToPost(vote(value), email));
                return null;
              }));
    }
    List<Throwable> errors = new ArrayList<>();
    for (Future<?> f : futures) {
      try {
        f.get(30, TimeUnit.SECONDS);
      } catch (java.util.concurrent.ExecutionException e) {
        errors.add(e.getCause());
      }
    }
    return errors;
  }

  private List<Integer> storedValues() {
    return jdbc.queryForList(
        "SELECT value_ FROM Vote WHERE user_id = ? AND post_id = ?", Integer.class, userId, postId);
  }

  @Test
  @DisplayName("Deux « +1 » simultanés : aucune erreur, et les deux bascules s'annulent (aucun vote)")
  void deux_votes_identiques_simultanes() throws Exception {
    for (int round = 0; round < ROUNDS; round++) {
      assertThat(concurrently(1, 1)).as("tour %d", round).isEmpty();
      // +1 puis +1 : le second retire le premier, dans un ordre comme dans l'autre.
      assertThat(storedValues()).as("tour %d", round).isEmpty();
    }
  }

  @Test
  @DisplayName("« +1 » et « −1 » simultanés : aucune erreur, un seul vote, celui du dernier appliqué")
  void deux_votes_opposes_simultanes() throws Exception {
    for (int round = 0; round < ROUNDS; round++) {
      assertThat(concurrently(1, -1)).as("tour %d", round).isEmpty();
      // +1 puis −1 → −1 ; −1 puis +1 → +1. Jamais deux lignes, jamais d'état perdu.
      assertThat(storedValues()).as("tour %d", round).hasSize(1).first().isIn(1, -1);
      jdbc.update("DELETE FROM Vote WHERE user_id = ?", userId);
    }
  }
}
