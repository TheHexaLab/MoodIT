package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.moodit.core_service.dto.ForumUpdatePostDTO;
import com.moodit.core_service.dto.PostCreateInForumDTO;
import com.moodit.core_service.dto.VoteCreateInPostDTO;
import com.moodit.core_service.exception.PostNotFoundException;
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
import java.util.function.Consumer;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * Les actions sur UN post (obtenir, réponses, répondre, modifier, supprimer, voter) cherchent ce
 * post par une requête ciblée (id + forum), sans charger tous les posts du forum (#30). Chaque
 * action est mesurée sur un petit forum (10 posts) et sur un gros (200 posts, un auteur distinct
 * par post) : le nombre de requêtes SQL ET le nombre d'entités chargées doivent être identiques.
 * Avec l'ancien parcours de {@code forum.getPosts()}, le gros forum chargeait ses 200 posts (et
 * leurs auteurs par lots de 50).
 *
 * <p>Comptage par les statistiques Hibernate, comme {@link ForumServiceN1Test}.
 */
@DataJpaTest
class ForumServicePostQueryCountTest {

  private static final int SMALL = 10;
  private static final int LARGE = 200;

  @Autowired private ForumRepository forumRepository;
  @Autowired private PostRepository postRepository;
  @Autowired private VoteRepository voteRepository;
  @Autowired private UserRepository userRepository;
  @Autowired private TestEntityManager em;
  @Autowired private EntityManagerFactory emf;

  private ForumService forumService;
  private FType thread;
  private Course course;
  private User voter;
  private int userSeq;

  /** Un forum peuplé et l'id de son post cible (le plus récent, avec votes et 2 réponses). */
  private record Seeded(Integer forumId, Integer targetId) {}

  /** Mesure d'une action : requêtes préparées et entités chargées. */
  private record Cost(long statements, long entityLoads) {}

  @BeforeEach
  void setUp() {
    forumService =
        new ForumService(
            forumRepository,
            postRepository,
            voteRepository,
            userRepository,
            mock(RealtimeEventPublisher.class),
            mock(AuditLogService.class));
    ReflectionTestUtils.setField(forumService, "entityManager", em.getEntityManager());

    thread = new FType();
    thread.setName("Thread");
    em.persist(thread);
    course = new Course();
    course.setTitle("Cours test");
    course.setCode("TST200");
    em.persist(course);
    voter = newUser();
  }

  private User newUser() {
    int i = userSeq++;
    User u = new User();
    u.setUsername("user" + i);
    u.setFirstName("Prenom" + i);
    u.setLastName("Nom" + i);
    u.setEmail("user" + i + "@test.ca");
    u.setPasswordHash("hash");
    em.persist(u);
    return u;
  }

  private Post newPost(Forum forum, User author, Post parent, String content) {
    Post p = new Post();
    p.setForum(forum);
    p.setUser(author);
    p.setContent(content);
    p.setTitle(parent == null ? "Sujet" : null);
    p.setIsPinned(false);
    p.setParent(parent);
    em.persist(p);
    return p;
  }

  /** Forum de {@code size} posts racines, un auteur distinct par post ; cible = le dernier. */
  private Seeded seed(int size) {
    Forum forum = new Forum();
    forum.setTitle("Forum " + size);
    forum.setPosition(1);
    forum.setFType(thread);
    forum.setCourse(course);
    em.persist(forum);

    Post target = null;
    for (int i = 0; i < size; i++) {
      target = newPost(forum, newUser(), null, "post " + i);
    }
    newPost(forum, voter, target, "réponse 1");
    newPost(forum, voter, target, "réponse 2");
    Vote v = new Vote();
    v.setPost(target);
    v.setUser(voter);
    v.setValue(1);
    em.persist(v);

    em.flush();
    em.clear();
    return new Seeded(forum.getId(), target.getId());
  }

  /** Coût de l'action (écritures comprises : flush avant la mesure de fin), L1 vide au départ. */
  private Cost cost(Seeded seeded, Consumer<Seeded> action) {
    Statistics stats = emf.unwrap(SessionFactory.class).getStatistics();
    stats.setStatisticsEnabled(true);
    em.clear();
    stats.clear();

    action.accept(seeded);
    em.flush();

    Cost cost = new Cost(stats.getPrepareStatementCount(), stats.getEntityLoadCount());
    em.clear();
    return cost;
  }

  /** L'action coûte autant sur 10 que sur 200 posts, sans charger les posts du forum. */
  private void assertConstant(String label, Consumer<Seeded> action) {
    Cost small = cost(seed(SMALL), action);
    Cost large = cost(seed(LARGE), action);
    System.out.printf("[#30] %s : %d posts → %s ; %d posts → %s%n", label, SMALL, small, LARGE, large);

    assertThat(large).as(label).isEqualTo(small);
    // Une poignée de requêtes et d'entités (bornes comme ForumServiceN1Test).
    assertThat(large.statements()).as(label + " (requêtes)").isLessThan(12);
    assertThat(large.entityLoads()).as(label + " (entités)").isLessThan(12);
  }

  @Test
  void getPostByForum_nombreConstant() {
    assertConstant("getPostByForum", s -> assertThat(
        forumService.getPostByForum(s.forumId(), s.targetId(), false, voter.getEmail())
            .getVoteTotalValue()).isEqualTo(1));
  }

  @Test
  void getRepliesByPost_nombreConstant() {
    assertConstant("getRepliesByPost", s -> assertThat(
        forumService.getRepliesByPost(s.forumId(), s.targetId(), voter.getEmail())).hasSize(2));
  }

  @Test
  void addPostToForum_reponse_nombreConstant() {
    assertConstant("addPostToForum (réponse)", s -> assertThat(
        forumService.addPostToForum(PostCreateInForumDTO.builder()
            .forumId(s.forumId()).content("nouvelle réponse").parentPostId(s.targetId()).build(),
            voter.getEmail()).getPostParentId()).isEqualTo(s.targetId()));
  }

  @Test
  void updatePost_nombreConstant() {
    assertConstant("updatePost", s -> assertThat(
        forumService.updatePost(s.forumId(), s.targetId(),
            ForumUpdatePostDTO.builder().content("modifié").build()).getContent())
        .isEqualTo("modifié"));
  }

  @Test
  void deletePost_nombreConstant() {
    assertConstant("deletePost", s -> forumService.deletePost(s.forumId(), s.targetId(), null));
  }

  @Test
  void addVoteToPost_nombreConstant() {
    assertConstant("addVoteToPost", s -> forumService.addVoteToPost(
        VoteCreateInPostDTO.builder().forumId(s.forumId()).postId(s.targetId()).voteValue(-1).build(),
        voter.getEmail()));
  }

  /** Un post qui existe mais dans un AUTRE forum reste introuvable (404), pour chaque action. */
  @Test
  void postDUnAutreForum_PostNotFound() {
    Seeded a = seed(SMALL);
    Seeded b = seed(SMALL);
    Integer foreign = b.targetId();

    assertThatThrownBy(() -> forumService.getPostByForum(a.forumId(), foreign, false, null))
        .isInstanceOf(PostNotFoundException.class);
    assertThatThrownBy(() -> forumService.getRepliesByPost(a.forumId(), foreign, null))
        .isInstanceOf(PostNotFoundException.class);
    assertThatThrownBy(() -> forumService.addPostToForum(PostCreateInForumDTO.builder()
            .forumId(a.forumId()).content("x").parentPostId(foreign).build(), voter.getEmail()))
        .isInstanceOf(PostNotFoundException.class);
    assertThatThrownBy(() -> forumService.updatePost(a.forumId(), foreign,
            ForumUpdatePostDTO.builder().content("x").build()))
        .isInstanceOf(PostNotFoundException.class);
    assertThatThrownBy(() -> forumService.deletePost(a.forumId(), foreign, null))
        .isInstanceOf(PostNotFoundException.class);

    em.flush();
    em.clear();
    Post untouched = postRepository.findById(foreign).orElseThrow();
    assertThat(untouched.getContent()).isEqualTo("post " + (SMALL - 1));
  }
}
