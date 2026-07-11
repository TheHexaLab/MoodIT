package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * Suppression d'un post AVEC réponses, selon le type de forum :
 *   - DISCUSSION (chat) : supprimer un message DÉTACHE ses réponses (parent → NULL) qui SURVIVENT
 *     — une réponse ne disparaît pas avec le message auquel elle répond.
 *   - THREAD (forum)    : supprimer un post supprime tout son sous-fil (cascade conservée).
 */
@DataJpaTest
class ForumServiceDeletePostTest {

  @Autowired private ForumRepository forumRepository;
  @Autowired private PostRepository postRepository;
  @Autowired private VoteRepository voteRepository;
  @Autowired private UserRepository userRepository;
  @Autowired private TestEntityManager em;

  private ForumService forumService;
  private User author;

  @BeforeEach
  void setUp() {
    forumService =
        new ForumService(
            forumRepository,
            postRepository,
            voteRepository,
            userRepository,
            mock(RealtimeEventPublisher.class));
    // Le champ entityManager (@PersistenceContext) n'est pas injecté quand on instancie le service
    // à la main : on branche l'EM du contexte de test.
    ReflectionTestUtils.setField(forumService, "entityManager", em.getEntityManager());

    author = new User();
    author.setUsername("author");
    author.setFirstName("Author");
    author.setLastName("Test");
    author.setEmail("author@test.ca");
    author.setPasswordHash("hash");
    em.persist(author);
  }

  private Forum newForum(String fTypeName) {
    FType t = new FType();
    t.setName(fTypeName);
    em.persist(t);
    Course c = new Course();
    c.setTitle("Cours " + fTypeName);
    c.setCode("C" + fTypeName);
    em.persist(c);
    Forum f = new Forum();
    f.setTitle("Canal " + fTypeName);
    f.setPosition(1);
    f.setFType(t);
    f.setCourse(c);
    em.persist(f);
    return f;
  }

  private Post newPost(Forum forum, Post parent, String content) {
    Post p = new Post();
    p.setForum(forum);
    p.setUser(author);
    p.setContent(content);
    p.setIsPinned(false);
    if (parent != null) p.setParent(parent);
    em.persist(p);
    return p;
  }

  @Test
  void discussion_supprimerParent_conserveLesReponses() {
    Forum forum = newForum("Discussion");
    Post parent = newPost(forum, null, "message parent");
    Post reply = newPost(forum, parent, "réponse");
    em.flush();
    em.clear();

    forumService.deletePost(forum.getId(), parent.getId());
    em.flush();
    em.clear();

    assertThat(postRepository.findById(parent.getId())).isEmpty(); // parent supprimé
    Post reloaded = postRepository.findById(reply.getId()).orElse(null);
    assertThat(reloaded).as("la réponse survit dans une discussion").isNotNull();
    assertThat(reloaded.getParent()).as("réponse détachée (parent → NULL)").isNull();
  }

  @Test
  void thread_supprimerParent_supprimeLeSousFil() {
    Forum forum = newForum("Thread");
    Post parent = newPost(forum, null, "sujet");
    Post reply = newPost(forum, parent, "réponse");
    em.flush();
    em.clear();

    forumService.deletePost(forum.getId(), parent.getId());
    em.flush();
    em.clear();

    assertThat(postRepository.findById(parent.getId())).isEmpty(); // sujet supprimé
    assertThat(postRepository.findById(reply.getId()))
        .as("dans un thread, la réponse part en cascade")
        .isEmpty();
  }
}
