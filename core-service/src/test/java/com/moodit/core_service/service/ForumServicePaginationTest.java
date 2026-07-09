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
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;

/**
 * Pagination par CURSEUR + exactitude du DTO de ForumService (chemin critique : c'est la logique
 * ajoutée par l'infinite scroll). Vérifie l'ordre (id DESC), le curseur `before` (id &lt; before,
 * sans recouvrement), la limite, le filtre racines de getRootPostsPage, et que les agrégats du DTO
 * (somme des votes, vote propre, nombre de réponses) sont corrects.
 */
@DataJpaTest
class ForumServicePaginationTest {

  @Autowired private ForumRepository forumRepository;
  @Autowired private PostRepository postRepository;
  @Autowired private VoteRepository voteRepository;
  @Autowired private UserRepository userRepository;
  @Autowired private TestEntityManager em;

  private ForumService forumService;
  private Integer forumId;
  private String currentUserEmail;
  private final List<Post> roots = new ArrayList<>(); // m0..m4, id croissant

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
    course.setTitle("Cours");
    course.setCode("TST100");
    em.persist(course);

    Forum forum = new Forum();
    forum.setTitle("Canal");
    forum.setPosition(1);
    forum.setFType(fType);
    forum.setCourse(course);
    em.persist(forum);
    forumId = forum.getId();

    User author = newUser("author");
    User voter = newUser("voter");
    currentUserEmail = author.getEmail();

    // 5 messages racines (ids croissants : m0 le plus ancien, m4 le plus récent).
    for (int i = 0; i < 5; i++) {
      Post p = new Post();
      p.setForum(forum);
      p.setUser(author);
      p.setContent("m" + i);
      p.setIsPinned(false);
      em.persist(p);
      roots.add(p);
    }

    // m0 : 2 votes (+1 auteur, +1 voter) → somme 2, vote propre de l'auteur = 1.
    persistVote(roots.get(0), author, 1);
    persistVote(roots.get(0), voter, 1);

    // m0 : 2 réponses → childrenCount = 2 (et exclues de getRootPostsPage).
    for (int i = 0; i < 2; i++) {
      Post reply = new Post();
      reply.setForum(forum);
      reply.setUser(author);
      reply.setContent("réponse " + i);
      reply.setIsPinned(false);
      reply.setParent(roots.get(0));
      em.persist(reply);
    }

    em.flush();
    em.clear();
  }

  private User newUser(String name) {
    User u = new User();
    u.setUsername(name);
    u.setFirstName(name);
    u.setLastName("Test");
    u.setEmail(name + "@test.ca");
    u.setPasswordHash("hash");
    em.persist(u);
    return u;
  }

  private void persistVote(Post post, User user, int value) {
    Vote v = new Vote();
    v.setPost(post);
    v.setUser(user);
    v.setValue(value);
    em.persist(v);
  }

  @Test
  void getRootPostsPage_pageRecente_ordreIdDescEtLimite() {
    List<PostVoteUserDTO> page = forumService.getRootPostsPage(forumId, null, 3, false, currentUserEmail);

    // 3 sujets les plus récents, du plus récent au plus ancien : m4, m3, m2.
    assertThat(page).hasSize(3);
    assertThat(page).extracting(PostVoteUserDTO::getContent).containsExactly("m4", "m3", "m2");
  }

  @Test
  void getRootPostsPage_curseurBefore_chargeLesPlusAnciensSansRecouvrement() {
    List<PostVoteUserDTO> firstPage =
        forumService.getRootPostsPage(forumId, null, 3, false, currentUserEmail);
    Integer oldestOnFirstPage = firstPage.get(firstPage.size() - 1).getId(); // id de m2

    List<PostVoteUserDTO> secondPage =
        forumService.getRootPostsPage(forumId, oldestOnFirstPage, 3, false, currentUserEmail);

    // Les sujets STRICTEMENT plus anciens que le curseur : m1, m0.
    assertThat(secondPage).extracting(PostVoteUserDTO::getContent).containsExactly("m1", "m0");
    // Aucun recouvrement entre les deux pages.
    assertThat(secondPage).extracting(PostVoteUserDTO::getId).doesNotContain(oldestOnFirstPage);
  }

  @Test
  void getRootPostsPage_dto_agregatsCorrects() {
    List<PostVoteUserDTO> all = forumService.getRootPostsPage(forumId, null, 10, false, currentUserEmail);

    PostVoteUserDTO m0 =
        all.stream().filter(d -> "m0".equals(d.getContent())).findFirst().orElseThrow();

    assertThat(m0.getVoteTotalValue()).isEqualTo(2); // +1 + +1
    assertThat(m0.getUserVoteValue()).isEqualTo(1); // vote propre de l'auteur
    assertThat(m0.getChildrenCount()).isEqualTo(2); // 2 réponses

    // Un sujet sans vote/réponse : agrégats à zéro / null (pas de NPE).
    PostVoteUserDTO m3 =
        all.stream().filter(d -> "m3".equals(d.getContent())).findFirst().orElseThrow();
    assertThat(m3.getVoteTotalValue()).isEqualTo(0);
    assertThat(m3.getUserVoteValue()).isNull();
    assertThat(m3.getChildrenCount()).isEqualTo(0);
  }

  @Test
  void getRootPostsPage_neRenvoieQueLesRacines() {
    List<PostVoteUserDTO> roots = forumService.getRootPostsPage(forumId, null, 50, false, currentUserEmail);
    // 5 racines seulement (les 2 réponses sont exclues : parent IS NULL).
    assertThat(roots).hasSize(5);
    assertThat(roots).allSatisfy(d -> assertThat(d.getPostParentId()).isNull());
  }

  @Test
  void getMessagesPage_renvoieRacinesEtReponsesAPlat() {
    List<PostVoteUserDTO> messages =
        forumService.getMessagesPage(forumId, null, 50, currentUserEmail);
    // 5 racines + 2 réponses = 7 messages à plat.
    assertThat(messages).hasSize(7);
  }
}
