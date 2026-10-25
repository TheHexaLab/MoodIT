package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.dto.ForumUpdateDTO;
import com.moodit.core_service.dto.ForumUpdatePostDTO;
import com.moodit.core_service.dto.PostCreateInForumDTO;
import com.moodit.core_service.dto.PostDTO;
import com.moodit.core_service.dto.PostVoteUserDTO;
import com.moodit.core_service.dto.VoteCreateInPostDTO;
import com.moodit.core_service.exception.ForumNotFoundException;
import com.moodit.core_service.exception.InvalidPostException;
import com.moodit.core_service.exception.PostNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.FType;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.model.Post;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.Vote;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.ChannelMessageDto;
import com.moodit.core_service.realtime.dto.ForumPostDto;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.PostRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.repository.VoteRepository;
import jakarta.persistence.EntityManager;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Pageable;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * Tests unitaires purs de {@link ForumService} (dépôts mockés). Complètent les tests @DataJpaTest
 * existants (pagination, anti-N+1, suppression avec réponses) : ici on vérifie la logique du
 * service (mapping DTO, votes, diffusion temps réel, audit, validations). Hors transaction,
 * {@code afterCommit} exécute l'écho tout de suite.
 *
 * <p>Les posts des fixtures ne référencent PAS leur forum (le service ne lit jamais
 * {@code post.getForum()} sur un post existant) : on évite ainsi les cycles Lombok
 * equals/hashCode/toString forum ↔ posts.
 */
@ExtendWith(MockitoExtension.class)
class ForumServiceTest {

  @Mock private ForumRepository forumRepository;
  @Mock private PostRepository postRepository;
  @Mock private VoteRepository voteRepository;
  @Mock private UserRepository userRepository;
  @Mock private RealtimeEventPublisher realtimePublisher;
  @Mock private AuditLogService auditLogService;
  @Mock private EntityManager entityManager;

  @InjectMocks private ForumService forumService;

  private static final LocalDateTime CREATED = LocalDateTime.of(2026, 3, 14, 15, 9, 26);

  private User alice;
  private User bob;

  @BeforeEach
  void setUp() {
    // @PersistenceContext n'est pas injecté par @InjectMocks (injection par constructeur).
    ReflectionTestUtils.setField(forumService, "entityManager", entityManager);
    alice = user(1, "alice");
    bob = user(2, "bob");
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────

  private static User user(int id, String username) {
    return User.builder().id(id).username(username).firstName(username.toUpperCase())
        .lastName("Test").email(username + "@test.ca").avatarColor("#00000" + id).build();
  }

  private static Forum forum(int id, String fTypeName) {
    FType t = new FType();
    t.setId("Discussion".equals(fTypeName) ? 1 : 2);
    t.setName(fTypeName);
    Course c = Course.builder().id(100).title("Base de données").code("IFT287").build();
    Forum f = new Forum();
    f.setId(id);
    f.setTitle("Canal " + id);
    f.setPosition(0);
    f.setFType(t);
    f.setCourse(c);
    f.setPosts(new ArrayList<>());
    return f;
  }

  private static Post post(int id, User author, String content) {
    Post p = new Post();
    p.setId(id);
    p.setUser(author);
    p.setContent(content);
    p.setTitle("Titre " + id);
    p.setIsPinned(false);
    p.setCreatedAt(CREATED);
    return p;
  }

  private static Vote vote(User voter, int value) {
    Vote v = new Vote();
    v.setUser(voter);
    v.setValue(value);
    return v;
  }

  // ── Transformations ───────────────────────────────────────────────────────

  @Nested
  class Transformations {

    @Test
    @DisplayName("toForumDTO copie titre, position, type et cours")
    void toForumDTO_copie_les_champs() {
      Forum source = forum(5, "Thread");
      source.setPosition(3);
      ForumDTO dto = forumService.toForumDTO(source);

      assertThat(dto.getId()).isEqualTo(5);
      assertThat(dto.getTitle()).isEqualTo("Canal 5");
      assertThat(dto.getPosition()).isEqualTo(3);
      assertThat(dto.getFTypeId()).isEqualTo(2);
      assertThat(dto.getFTypeName()).isEqualTo("Thread");
      assertThat(dto.getCourseId()).isEqualTo(100);
    }

    @Test
    @DisplayName("toPostDTO convertit createdAt (UTC) en Instant ; null reste null")
    void toPostDTO_convertit_la_date() {
      Post p = post(7, alice, "bonjour");
      p.setIsPinned(true);

      PostDTO dto = forumService.toPostDTO(p);

      assertThat(dto.getId()).isEqualTo(7);
      assertThat(dto.getCreatedAt()).hasToString("2026-03-14T15:09:26Z");
      assertThat(dto.getContent()).isEqualTo("bonjour");
      assertThat(dto.getTitle()).isEqualTo("Titre 7");
      assertThat(dto.getIsPinned()).isTrue();

      p.setCreatedAt(null);
      assertThat(forumService.toPostDTO(p).getCreatedAt()).isNull();
    }

    @Test
    @DisplayName("toPostVoteUserDTO : somme des votes, vote propre, parent, auteur et enfants déroulés (un niveau)")
    void toPostVoteUserDTO_calcule_les_agregats() {
      Post parent = post(1, bob, "parent");
      Post p = post(2, alice, "message");
      p.setParent(parent);
      p.setVotes(List.of(vote(alice, 1), vote(bob, 1), vote(user(3, "carl"), -1)));
      Post child = post(3, bob, "réponse");
      child.setChildren(List.of(post(4, bob, "petite-fille")));
      p.setChildren(List.of(child));

      p.setIsPinned(true);
      PostVoteUserDTO dto = forumService.toPostVoteUserDTO(p, true, 2);

      assertThat(dto.getCreatedAt()).hasToString("2026-03-14T15:09:26Z");
      assertThat(dto.getTitle()).isEqualTo("Titre 2");
      assertThat(dto.getIsPinned()).isTrue();
      assertThat(dto.getVoteTotalValue()).isEqualTo(1);
      assertThat(dto.getUserVoteValue()).as("vote propre de bob").isEqualTo(1);
      assertThat(dto.getUserId()).isEqualTo(1);
      assertThat(dto.getPostParentId()).isEqualTo(1);
      assertThat(dto.getAuthor().getId()).isEqualTo(1);
      assertThat(dto.getAuthor().getFirstName()).isEqualTo("ALICE");
      assertThat(dto.getAuthor().getLastName()).isEqualTo("Test");
      assertThat(dto.getAuthor().getEmail()).isEqualTo("alice@test.ca");
      assertThat(dto.getAuthor().getAvatarColor()).isEqualTo("#000001");
      assertThat(dto.getChildrenCount()).isEqualTo(1);
      assertThat(dto.getChildren()).hasSize(1);
      // Non récursif : les enfants ne sont pas déroulés, seul leur nombre est donné.
      assertThat(dto.getChildren().get(0).getChildren()).isNull();
      assertThat(dto.getChildren().get(0).getChildrenCount()).isEqualTo(1);
    }

    @Test
    @DisplayName("toPostVoteUserDTO : post neuf (collections null), sans utilisateur courant → 0 / null, pas de NPE")
    void toPostVoteUserDTO_collections_null() {
      Post p = post(2, alice, "neuf");

      PostVoteUserDTO dto = forumService.toPostVoteUserDTO(p, true, null);

      assertThat(dto.getVoteTotalValue()).isZero();
      assertThat(dto.getUserVoteValue()).isNull();
      assertThat(dto.getChildrenCount()).isZero();
      assertThat(dto.getChildren()).isNull();
      assertThat(dto.getPostParentId()).isNull();
    }

    @Test
    @DisplayName("toPostVoteUserDTO : utilisateur courant n'ayant pas voté → userVoteValue null")
    void toPostVoteUserDTO_utilisateur_sans_vote() {
      Post p = post(2, alice, "m");
      p.setVotes(List.of(vote(alice, -1)));

      assertThat(forumService.toPostVoteUserDTO(p, false, 2).getUserVoteValue()).isNull();
      assertThat(forumService.toPostVoteUserDTO(p, false, 1).getUserVoteValue()).isEqualTo(-1);
    }
  }

  // ── Ciblage : l'id demandé, pas le premier post du forum ──────────────────

  /**
   * Chaque opération sur un post le cherche PAR ID dans le forum. Le forum contient ici un post
   * leurre (6) AVANT la cible (7) : un filtre qui laisserait tout passer prendrait le leurre.
   */
  @Nested
  class Ciblage_du_post {

    private Forum f;
    private Post leurre;
    private Post cible;

    @BeforeEach
    void setUp() {
      f = forum(5, "Thread");
      leurre = post(6, bob, "leurre");
      leurre.setChildren(List.of(post(60, bob, "réponse au leurre")));
      cible = post(7, alice, "cible");
      f.getPosts().add(leurre);
      f.getPosts().add(cible);
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));
    }

    @Test
    @DisplayName("getPostByForum renvoie le post demandé, pas le premier du forum")
    void getPostByForum_bonPost() {
      assertThat(forumService.getPostByForum(5, 7, false, null).getId()).isEqualTo(7);
    }

    @Test
    @DisplayName("getRepliesByPost renvoie les réponses du post demandé")
    void getRepliesByPost_bonPost() {
      // La cible n'a pas de réponse : celles du leurre ne doivent pas fuiter.
      assertThat(forumService.getRepliesByPost(5, 7, null)).isEmpty();
    }

    @Test
    @DisplayName("addPostToForum rattache la réponse au parent demandé")
    void addPostToForum_bonParent() {
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(postRepository.saveAndFlush(any())).thenAnswer(inv -> {
        Post saved = inv.getArgument(0);
        saved.setId(70);
        return saved;
      });

      forumService.addPostToForum(PostCreateInForumDTO.builder()
          .forumId(5).content("réponse").parentPostId(7).build(), "alice@test.ca");

      ArgumentCaptor<Post> saved = ArgumentCaptor.forClass(Post.class);
      verify(postRepository).saveAndFlush(saved.capture());
      assertThat(saved.getValue().getParent()).isSameAs(cible);
    }

    @Test
    @DisplayName("updatePost modifie le post demandé, le leurre reste intact")
    void updatePost_bonPost() {
      PostDTO result = forumService.updatePost(5, 7, ForumUpdatePostDTO.builder().isPinned(true).build());

      assertThat(result.getId()).isEqualTo(7);
      assertThat(cible.getIsPinned()).isTrue();
      assertThat(leurre.getIsPinned()).isFalse();
    }
  }

  // ── Lectures ──────────────────────────────────────────────────────────────

  @Nested
  class Lectures {

    @Test
    @DisplayName("getForumType renvoie le nom du type ; findById le DTO")
    void getForumType_et_findById() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Discussion")));

      assertThat(forumService.getForumType(5)).isEqualTo("Discussion");
      assertThat(forumService.findById(5).getId()).isEqualTo(5);
    }

    @Test
    @DisplayName("Forum inconnu → ForumNotFoundException (getForumType, findById, pages)")
    void forum_inconnu() {
      when(forumRepository.findById(9)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> forumService.getForumType(9)).isInstanceOf(ForumNotFoundException.class);
      assertThatThrownBy(() -> forumService.findById(9)).isInstanceOf(ForumNotFoundException.class);
      assertThatThrownBy(() -> forumService.getMessagesPage(9, null, 10, null))
          .isInstanceOf(ForumNotFoundException.class);
      assertThatThrownBy(() -> forumService.getRootPostsPage(9, null, 10, false, null))
          .isInstanceOf(ForumNotFoundException.class);
      verifyNoInteractions(postRepository);
    }

    @Test
    @DisplayName("getPostByForum résout l'utilisateur courant par email et surligne son vote")
    void getPostByForum_resout_le_vote_propre() {
      Forum f = forum(5, "Thread");
      Post p = post(7, alice, "sujet");
      p.setVotes(List.of(vote(bob, -1)));
      f.getPosts().add(p);
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));
      when(userRepository.findByEmail("bob@test.ca")).thenReturn(Optional.of(bob));

      PostVoteUserDTO dto = forumService.getPostByForum(5, 7, false, "bob@test.ca");

      assertThat(dto.getId()).isEqualTo(7);
      assertThat(dto.getUserVoteValue()).isEqualTo(-1);
    }

    @Test
    @DisplayName("getPostByForum : post absent du forum → PostNotFoundException ; email vide → pas de résolution")
    void getPostByForum_post_absent() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Thread")));

      assertThatThrownBy(() -> forumService.getPostByForum(5, 7, false, "  "))
          .isInstanceOf(PostNotFoundException.class);
      verifyNoInteractions(userRepository);
    }

    @Test
    @DisplayName("getRepliesByPost agrège votes, vote propre et nombre de réponses par lot")
    void getRepliesByPost_par_lot() {
      Forum f = forum(5, "Discussion");
      Post root = post(1, alice, "racine");
      Post r1 = post(2, bob, "r1");
      r1.setParent(root);
      Post r2 = post(3, alice, "r2");
      r2.setParent(root);
      root.setChildren(List.of(r1, r2));
      f.getPosts().add(root);
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(voteRepository.sumValueByPostIds(List.of(2, 3)))
          .thenReturn(List.<Object[]>of(new Object[] {2, 3L}));
      when(voteRepository.valueByUserAndPostIds(1, List.of(2, 3)))
          .thenReturn(List.<Object[]>of(new Object[] {2, -1}));
      when(postRepository.countChildrenByParentIds(List.of(2, 3)))
          .thenReturn(List.<Object[]>of(new Object[] {3, 4L}));

      List<PostVoteUserDTO> replies = forumService.getRepliesByPost(5, 1, "alice@test.ca");

      assertThat(replies).extracting(PostVoteUserDTO::getId).containsExactly(2, 3);
      PostVoteUserDTO first = replies.get(0);
      assertThat(first.getVoteTotalValue()).isEqualTo(3);
      assertThat(first.getUserVoteValue()).isEqualTo(-1);
      assertThat(first.getChildrenCount()).isZero();
      assertThat(first.getPostParentId()).isEqualTo(1);
      assertThat(first.getAuthor().getUsername()).isEqualTo("bob");
      assertThat(first.getUserId()).isEqualTo(2);
      assertThat(first.getTitle()).isEqualTo("Titre 2");
      assertThat(first.getIsPinned()).isFalse();
      assertThat(first.getCreatedAt()).hasToString("2026-03-14T15:09:26Z");
      PostVoteUserDTO second = replies.get(1);
      assertThat(second.getVoteTotalValue()).isZero();
      assertThat(second.getUserVoteValue()).isNull();
      assertThat(second.getChildrenCount()).isEqualTo(4);
      assertThat(second.getChildren()).isNull();
    }

    @Test
    @DisplayName("getRepliesByPost : sans réponse (children null) → liste vide, aucune requête agrégée")
    void getRepliesByPost_sans_reponse() {
      Forum f = forum(5, "Discussion");
      f.getPosts().add(post(1, alice, "racine"));
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));

      assertThat(forumService.getRepliesByPost(5, 1, null)).isEmpty();
      verifyNoInteractions(voteRepository);
    }

    @Test
    @DisplayName("getRepliesByPost : post absent → PostNotFoundException")
    void getRepliesByPost_post_absent() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Discussion")));

      assertThatThrownBy(() -> forumService.getRepliesByPost(5, 1, null))
          .isInstanceOf(PostNotFoundException.class);
    }

    @Test
    @DisplayName("getMessagesPage borne la taille : ≤ 0 → 30, > 100 → 100 ; curseur transmis ; sans utilisateur pas de vote propre")
    void getMessagesPage_borne_la_limite() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Discussion")));
      when(postRepository.findMessagesPage(eq(5), any(), any())).thenReturn(List.of());

      assertThat(forumService.getMessagesPage(5, 40, 0, null)).isEmpty();
      forumService.getMessagesPage(5, null, 500, null);
      forumService.getMessagesPage(5, null, 15, null);

      ArgumentCaptor<Pageable> pages = ArgumentCaptor.forClass(Pageable.class);
      verify(postRepository).findMessagesPage(eq(5), eq(40), pages.capture());
      verify(postRepository, org.mockito.Mockito.times(2)).findMessagesPage(eq(5), eq(null), pages.capture());
      assertThat(pages.getAllValues()).extracting(Pageable::getPageSize).containsExactly(30, 100, 15);
      assertThat(pages.getAllValues()).extracting(Pageable::getPageNumber).containsOnly(0);
      verifyNoInteractions(voteRepository);
    }

    @Test
    @DisplayName("getMessagesPage : avec un lot, la requête du vote propre est omise si l'utilisateur est inconnu")
    void getMessagesPage_utilisateur_inconnu() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Discussion")));
      when(userRepository.findByEmail("x@test.ca")).thenReturn(Optional.empty());
      when(postRepository.findMessagesPage(eq(5), any(), any())).thenReturn(List.of(post(1, alice, "m")));
      when(voteRepository.sumValueByPostIds(List.of(1))).thenReturn(List.of());
      when(postRepository.countChildrenByParentIds(List.of(1))).thenReturn(List.of());

      List<PostVoteUserDTO> page = forumService.getMessagesPage(5, null, 10, "x@test.ca");

      assertThat(page).hasSize(1);
      assertThat(page.get(0).getUserVoteValue()).isNull();
      verify(voteRepository, never()).valueByUserAndPostIds(any(), any());
    }

    @Test
    @DisplayName("getRootPostsPage : ≤ 0 → 20 ; loadChildren = true déroule les réponses sans requête agrégée")
    void getRootPostsPage_loadChildren() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Thread")));
      Post root = post(1, alice, "sujet");
      root.setChildren(List.of(post(2, bob, "réponse")));
      when(postRepository.findRootPostsPage(eq(5), eq(null), any())).thenReturn(List.of(root));

      List<PostVoteUserDTO> page = forumService.getRootPostsPage(5, null, -1, true, null);

      ArgumentCaptor<Pageable> pageable = ArgumentCaptor.forClass(Pageable.class);
      verify(postRepository).findRootPostsPage(eq(5), eq(null), pageable.capture());
      assertThat(pageable.getValue().getPageSize()).isEqualTo(20);
      assertThat(page).hasSize(1);
      assertThat(page.get(0).getChildren()).extracting(PostVoteUserDTO::getContent).containsExactly("réponse");
      verifyNoInteractions(voteRepository);
    }

    @Test
    @DisplayName("getRootPostsPage : limite 0 → taille par défaut 20 (borne incluse)")
    void getRootPostsPage_limiteZero() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Thread")));
      when(postRepository.findRootPostsPage(eq(5), eq(null), any())).thenReturn(List.of());

      forumService.getRootPostsPage(5, null, 0, false, null);

      ArgumentCaptor<Pageable> pageable = ArgumentCaptor.forClass(Pageable.class);
      verify(postRepository).findRootPostsPage(eq(5), eq(null), pageable.capture());
      assertThat(pageable.getValue().getPageSize()).isEqualTo(20);
    }

    @Test
    @DisplayName("getRootPostsPage : > 100 → 100 en mode lot")
    void getRootPostsPage_borne_haute() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Thread")));
      when(postRepository.findRootPostsPage(eq(5), eq(3), any())).thenReturn(List.of());

      assertThat(forumService.getRootPostsPage(5, 3, 1000, false, null)).isEmpty();

      ArgumentCaptor<Pageable> pageable = ArgumentCaptor.forClass(Pageable.class);
      verify(postRepository).findRootPostsPage(eq(5), eq(3), pageable.capture());
      assertThat(pageable.getValue().getPageSize()).isEqualTo(100);
    }
  }

  // ── addPostToForum ────────────────────────────────────────────────────────

  @Nested
  class AddPostToForum {

    private PostCreateInForumDTO dto(int forumId, String content, Integer parentId) {
      return PostCreateInForumDTO.builder()
          .forumId(forumId).content(content).title("Titre").parentPostId(parentId)
          .clientMessageId("msg-1").clientPostId("post-1").build();
    }

    private void stubSave(int id) {
      when(postRepository.saveAndFlush(any())).thenAnswer(inv -> {
        Post p = inv.getArgument(0);
        p.setId(id);
        p.setCreatedAt(CREATED);
        return p;
      });
    }

    @Test
    @DisplayName("Discussion : persiste le message (réponse) et émet messageCreated avec le clientMessageId")
    void discussion_emet_messageCreated() {
      Forum f = forum(5, "Discussion");
      Post parent = post(1, bob, "question");
      f.getPosts().add(parent);
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      stubSave(50);

      PostVoteUserDTO result = forumService.addPostToForum(dto(5, "réponse", 1), "alice@test.ca");

      ArgumentCaptor<Post> saved = ArgumentCaptor.forClass(Post.class);
      verify(postRepository).saveAndFlush(saved.capture());
      assertThat(saved.getValue().getForum()).isSameAs(f);
      assertThat(saved.getValue().getUser()).isSameAs(alice);
      assertThat(saved.getValue().getParent()).isSameAs(parent);
      assertThat(saved.getValue().getIsPinned()).isFalse();

      ArgumentCaptor<ChannelMessageDto> msg = ArgumentCaptor.forClass(ChannelMessageDto.class);
      verify(realtimePublisher).messageCreated(eq(5L), msg.capture());
      assertThat(msg.getValue().id()).isEqualTo(50L);
      assertThat(msg.getValue().content()).isEqualTo("réponse");
      assertThat(msg.getValue().createdAt()).isEqualTo("2026-03-14T15:09:26Z");
      assertThat(msg.getValue().postParentId()).isEqualTo(1L);
      assertThat(msg.getValue().clientMsgId()).isEqualTo("msg-1");
      assertThat(msg.getValue().author().username()).isEqualTo("alice");
      verify(realtimePublisher, never()).postCreated(anyLong(), any(), any());

      assertThat(result.getId()).isEqualTo(50);
      assertThat(result.getPostParentId()).isEqualTo(1);
      assertThat(result.getVoteTotalValue()).isZero();
    }

    @Test
    @DisplayName("Thread : sujet racine, émet postCreated avec le clientPostId et parentId null")
    void thread_emet_postCreated() {
      Forum f = forum(6, "Thread");
      when(forumRepository.findById(6)).thenReturn(Optional.of(f));
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      stubSave(60);

      forumService.addPostToForum(dto(6, "sujet", null), "alice@test.ca");

      ArgumentCaptor<ForumPostDto> post = ArgumentCaptor.forClass(ForumPostDto.class);
      verify(realtimePublisher).postCreated(eq(6L), post.capture(), eq(null));
      assertThat(post.getValue().id()).isEqualTo(60L);
      assertThat(post.getValue().title()).isEqualTo("Titre");
      assertThat(post.getValue().isPinned()).isFalse();
      assertThat(post.getValue().replyCount()).isZero();
      assertThat(post.getValue().clientPostId()).isEqualTo("post-1");
      verify(realtimePublisher, never()).messageCreated(anyLong(), any());
    }

    @Test
    @DisplayName("Parent absent du forum → PostNotFoundException, rien n'est persisté")
    void parent_absent() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Discussion")));
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));

      assertThatThrownBy(() -> forumService.addPostToForum(dto(5, "x", 99), "alice@test.ca"))
          .isInstanceOf(PostNotFoundException.class);
      verify(postRepository, never()).saveAndFlush(any());
    }

    @Test
    @DisplayName("Forum ou utilisateur inconnu → exception dédiée, aucun écho")
    void forum_ou_utilisateur_inconnu() {
      when(forumRepository.findById(5)).thenReturn(Optional.empty());
      assertThatThrownBy(() -> forumService.addPostToForum(dto(5, "x", null), "alice@test.ca"))
          .isInstanceOf(ForumNotFoundException.class);

      when(forumRepository.findById(6)).thenReturn(Optional.of(forum(6, "Thread")));
      when(userRepository.findByEmail("inconnu@test.ca")).thenReturn(Optional.empty());
      assertThatThrownBy(() -> forumService.addPostToForum(dto(6, "x", null), "inconnu@test.ca"))
          .isInstanceOf(UserNotFoundException.class);

      verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("Contenu null → InvalidPostException avant tout accès BD")
    void contenu_null() {
      assertThatThrownBy(() -> forumService.addPostToForum(dto(5, null, null), "alice@test.ca"))
          .isInstanceOf(InvalidPostException.class);
      verifyNoInteractions(forumRepository, postRepository);
    }
  }

  // ── addVoteToPost ─────────────────────────────────────────────────────────

  @Nested
  class AddVoteToPost {

    private VoteCreateInPostDTO dto(int value) {
      return VoteCreateInPostDTO.builder().forumId(5).postId(7).voteValue(value).build();
    }

    private Post sujet;

    @BeforeEach
    void postVerrouille() {
      sujet = post(7, bob, "sujet");
    }

    /** Le post 7 du forum 5, chargé ET verrouillé (SELECT … FOR UPDATE). */
    private void postTrouve() {
      when(postRepository.findByIdAndForumIdForUpdate(7, 5)).thenReturn(Optional.of(sujet));
    }

    @Test
    @DisplayName("Premier vote : crée le vote sur le post et diffuse la valeur résultante")
    void premier_vote_cree() {
      Post p = sujet;
      postTrouve();
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(voteRepository.findByUserIdAndPostId(1, 7)).thenReturn(Optional.empty());

      forumService.addVoteToPost(dto(1), "alice@test.ca");

      ArgumentCaptor<Vote> saved = ArgumentCaptor.forClass(Vote.class);
      verify(voteRepository).save(saved.capture());
      assertThat(saved.getValue().getPost()).isSameAs(p);
      assertThat(saved.getValue().getUser()).isSameAs(alice);
      assertThat(saved.getValue().getValue()).isEqualTo(1);
      verify(realtimePublisher).postVoted(5L, 7L, 1L, 1);
      verifyNoInteractions(forumRepository); // post trouvé : pas de chargement du forum
    }

    @Test
    @DisplayName("Le post est verrouillé AVANT de lire le vote existant (sérialise les votes simultanés)")
    void verrou_avant_lecture_du_vote() {
      postTrouve();
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(voteRepository.findByUserIdAndPostId(1, 7)).thenReturn(Optional.empty());

      forumService.addVoteToPost(dto(1), "alice@test.ca");

      org.mockito.InOrder ordre = org.mockito.Mockito.inOrder(postRepository, voteRepository);
      ordre.verify(postRepository).findByIdAndForumIdForUpdate(7, 5);
      ordre.verify(voteRepository).findByUserIdAndPostId(1, 7);
    }

    @Test
    @DisplayName("Dans une transaction, postVoted n'est émis qu'APRÈS le commit")
    void echo_differe_apres_commit() {
      postTrouve();
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(voteRepository.findByUserIdAndPostId(1, 7)).thenReturn(Optional.of(vote(alice, 1)));
      org.springframework.transaction.support.TransactionSynchronizationManager.initSynchronization();
      try {
        forumService.addVoteToPost(dto(-1), "alice@test.ca");
        verifyNoInteractions(realtimePublisher);

        org.springframework.transaction.support.TransactionSynchronizationManager.getSynchronizations()
            .forEach(org.springframework.transaction.support.TransactionSynchronization::afterCommit);
        verify(realtimePublisher).postVoted(5L, 7L, 1L, -1);
      } finally {
        org.springframework.transaction.support.TransactionSynchronizationManager.clearSynchronization();
      }
    }

    @Test
    @DisplayName("Même valeur qu'avant : le vote est annulé (supprimé) et la valeur diffusée est 0")
    void meme_valeur_annule() {
      Vote existing = vote(alice, 1);
      postTrouve();
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(voteRepository.findByUserIdAndPostId(1, 7)).thenReturn(Optional.of(existing));

      forumService.addVoteToPost(dto(1), "alice@test.ca");

      verify(voteRepository).delete(existing);
      verify(voteRepository, never()).save(any());
      verify(realtimePublisher).postVoted(5L, 7L, 1L, 0);
    }

    @Test
    @DisplayName("Valeur opposée : le vote existant est modifié en place")
    void valeur_opposee_modifie() {
      Vote existing = vote(alice, 1);
      postTrouve();
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(voteRepository.findByUserIdAndPostId(1, 7)).thenReturn(Optional.of(existing));

      forumService.addVoteToPost(dto(-1), "alice@test.ca");

      assertThat(existing.getValue()).isEqualTo(-1);
      verify(voteRepository, never()).delete(any());
      verify(voteRepository, never()).save(any());
      verifyNoInteractions(forumRepository);
      verify(realtimePublisher).postVoted(5L, 7L, 1L, -1);
    }

    @Test
    @DisplayName("Post absent du forum ou utilisateur inconnu → exception, aucun vote ni écho")
    void post_absent_ou_utilisateur_inconnu() {
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(postRepository.findByIdAndForumIdForUpdate(7, 5)).thenReturn(Optional.empty());
      when(forumRepository.existsById(5)).thenReturn(true);
      assertThatThrownBy(() -> forumService.addVoteToPost(dto(1), "alice@test.ca"))
          .isInstanceOf(PostNotFoundException.class);
      verify(voteRepository, never()).findByUserIdAndPostId(any(), any());

      when(userRepository.findByEmail("x@test.ca")).thenReturn(Optional.empty());
      assertThatThrownBy(() -> forumService.addVoteToPost(dto(1), "x@test.ca"))
          .isInstanceOf(UserNotFoundException.class);

      verify(voteRepository, never()).save(any());
      verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("Forum inexistant → ForumNotFoundException, aucun vote ni écho")
    void forum_inexistant() {
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));
      when(postRepository.findByIdAndForumIdForUpdate(7, 5)).thenReturn(Optional.empty());
      when(forumRepository.existsById(5)).thenReturn(false);

      assertThatThrownBy(() -> forumService.addVoteToPost(dto(1), "alice@test.ca"))
          .isInstanceOf(ForumNotFoundException.class);
      verifyNoInteractions(voteRepository, realtimePublisher);
    }
  }

  // ── updateForum / updatePost ──────────────────────────────────────────────

  @Nested
  class Mises_a_jour {

    @Test
    @DisplayName("updateForum renomme, sauvegarde et journalise FORUM_UPDATE avec le contexte du cours")
    void updateForum_renomme_et_journalise() {
      Forum f = forum(5, "Thread");
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));

      ForumDTO result = forumService.updateForum(5, ForumUpdateDTO.builder().title("Annonces").build());

      assertThat(result.getTitle()).isEqualTo("Annonces");
      verify(forumRepository).save(f);
      verify(auditLogService).record("FORUM_UPDATE", "FORUM", 5,
          "Forum « Annonces » mis à jour", "Cours : Base de données (IFT287)");
    }

    @Test
    @DisplayName("updateForum : titre null → inchangé ; forum inconnu → ForumNotFoundException")
    void updateForum_titre_null_et_inconnu() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Thread")));
      when(forumRepository.findById(9)).thenReturn(Optional.empty());

      assertThat(forumService.updateForum(5, new ForumUpdateDTO()).getTitle()).isEqualTo("Canal 5");
      assertThatThrownBy(() -> forumService.updateForum(9, new ForumUpdateDTO()))
          .isInstanceOf(ForumNotFoundException.class);
    }

    @Test
    @DisplayName("updatePost (Discussion) : contenu modifié → messageEdited")
    void updatePost_discussion_messageEdited() {
      Forum f = forum(5, "Discussion");
      Post p = post(7, alice, "avant");
      f.getPosts().add(p);
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));

      PostDTO result = forumService.updatePost(5, 7,
          ForumUpdatePostDTO.builder().content("après").build());

      assertThat(result.getContent()).isEqualTo("après");
      assertThat(p.getContent()).isEqualTo("après");
      verify(realtimePublisher).messageEdited(5L, 7L, "après");
      verify(realtimePublisher, never()).postEdited(anyLong(), anyLong(), any(), any());
    }

    @Test
    @DisplayName("updatePost (Thread) : titre + épinglage → postEdited avec contenu et titre")
    void updatePost_thread_postEdited() {
      Forum f = forum(6, "Thread");
      Post p = post(8, alice, "contenu");
      f.getPosts().add(p);
      when(forumRepository.findById(6)).thenReturn(Optional.of(f));

      PostDTO result = forumService.updatePost(6, 8,
          ForumUpdatePostDTO.builder().title("Nouveau titre").isPinned(true).build());

      assertThat(result.getTitle()).isEqualTo("Nouveau titre");
      assertThat(result.getIsPinned()).isTrue();
      verify(realtimePublisher).postEdited(6L, 8L, "contenu", "Nouveau titre");
    }

    @Test
    @DisplayName("updatePost : épinglage seul → aucune diffusion temps réel")
    void updatePost_epinglage_seul_sans_echo() {
      Forum f = forum(6, "Thread");
      Post p = post(8, alice, "contenu");
      f.getPosts().add(p);
      when(forumRepository.findById(6)).thenReturn(Optional.of(f));

      forumService.updatePost(6, 8, ForumUpdatePostDTO.builder().isPinned(true).build());

      assertThat(p.getIsPinned()).isTrue();
      verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("updatePost : contenu trop long → InvalidPostException, post inchangé")
    void updatePost_contenu_trop_long() {
      Forum f = forum(5, "Discussion");
      Post p = post(7, alice, "avant");
      f.getPosts().add(p);
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));
      String tooLong = "a".repeat(ForumService.MAX_CONTENT_LENGTH + 1);

      assertThatThrownBy(() -> forumService.updatePost(5, 7,
              ForumUpdatePostDTO.builder().content(tooLong).build()))
          .isInstanceOf(InvalidPostException.class);
      assertThat(p.getContent()).isEqualTo("avant");
      verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("updatePost : post absent → PostNotFoundException")
    void updatePost_post_absent() {
      when(forumRepository.findById(5)).thenReturn(Optional.of(forum(5, "Discussion")));

      assertThatThrownBy(() -> forumService.updatePost(5, 7, new ForumUpdatePostDTO()))
          .isInstanceOf(PostNotFoundException.class);
    }
  }

  // ── Suppressions ──────────────────────────────────────────────────────────

  @Nested
  class Suppressions {

    @Test
    @DisplayName("deleteForum supprime et journalise FORUM_DELETE avec le contexte du cours")
    void deleteForum_supprime_et_journalise() {
      Forum f = forum(5, "Thread");
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));

      forumService.deleteForum(5);

      verify(forumRepository).delete(f);
      verify(auditLogService).record("FORUM_DELETE", "FORUM", 5, "Forum #5 supprimé",
          "Cours : Base de données (IFT287)");
    }

    @Test
    @DisplayName("deleteForum : forum inconnu → ForumNotFoundException, aucun audit")
    void deleteForum_inconnu() {
      when(forumRepository.findById(5)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> forumService.deleteForum(5)).isInstanceOf(ForumNotFoundException.class);
      verifyNoInteractions(auditLogService);
    }

    @Test
    @DisplayName("deletePost (Thread) par un modérateur : supprime, journalise POST_MODERATION_DELETE et émet postDeleted")
    void deletePost_thread_moderation() {
      Forum f = forum(6, "Thread");
      Post p = post(8, alice, "sujet");
      f.getPosts().add(p);
      when(forumRepository.findById(6)).thenReturn(Optional.of(f));
      when(userRepository.findByEmail("bob@test.ca")).thenReturn(Optional.of(bob));

      forumService.deletePost(6, 8, "bob@test.ca");

      verify(postRepository).delete(p);
      verify(postRepository, never()).detachDirectChildren(any());
      verify(auditLogService).record("POST_MODERATION_DELETE", "POST", 8,
          "Post de alice@test.ca supprimé dans « Canal 6 » (modération)",
          "Cours : Base de données (IFT287)");
      verify(realtimePublisher).postDeleted(6L, 8L);
    }

    @Test
    @DisplayName("deletePost (Discussion) : détache les réponses, vide le contexte, recharge et supprime ; messageDeleted")
    void deletePost_discussion_detache_les_reponses() {
      Forum f = forum(5, "Discussion");
      Post p = post(7, alice, "message");
      f.getPosts().add(p);
      Post reloaded = post(7, alice, "message");
      when(forumRepository.findById(5)).thenReturn(Optional.of(f));
      when(userRepository.findByEmail("bob@test.ca")).thenReturn(Optional.of(bob));
      when(postRepository.findById(7)).thenReturn(Optional.of(reloaded));

      forumService.deletePost(5, 7, "bob@test.ca");

      InOrder order = inOrder(postRepository, entityManager);
      order.verify(postRepository).detachDirectChildren(7);
      order.verify(entityManager).clear();
      order.verify(postRepository).findById(7);
      order.verify(postRepository).delete(reloaded);
      verify(auditLogService).record(eq("POST_MODERATION_DELETE"), eq("POST"), eq(7),
          eq("Message de alice@test.ca supprimé dans « Canal 5 » (modération)"), anyString());
      verify(realtimePublisher).messageDeleted(5L, 7L);
    }

    @Test
    @DisplayName("deletePost : auto-suppression ou appelant non identifié → pas d'audit de modération")
    void deletePost_auto_suppression_sans_audit() {
      Forum f = forum(6, "Thread");
      f.getPosts().add(post(8, alice, "a"));
      f.getPosts().add(post(9, alice, "b"));
      when(forumRepository.findById(6)).thenReturn(Optional.of(f));
      when(userRepository.findByEmail("alice@test.ca")).thenReturn(Optional.of(alice));

      forumService.deletePost(6, 8, "alice@test.ca");
      forumService.deletePost(6, 9, null);

      verifyNoInteractions(auditLogService);
      verify(realtimePublisher).postDeleted(6L, 8L);
      verify(realtimePublisher).postDeleted(6L, 9L);
    }

    @Test
    @DisplayName("deletePost : forum inconnu → ForumNotFoundException")
    void deletePost_forum_inconnu() {
      when(forumRepository.findById(6)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> forumService.deletePost(6, 8, null))
          .isInstanceOf(ForumNotFoundException.class);
      verifyNoInteractions(postRepository);
    }

    // Bogue : deletePost lève une RuntimeException("Post not found") générique (non gérée par
    // GlobalExceptionHandler → HTTP 500) au lieu de PostNotFoundException (→ 404), contrairement
    // à getPostByForum / updatePost pour le même cas.
    @Test
    @DisplayName("deletePost : post absent du forum → PostNotFoundException (404)")
    void deletePost_post_absent_devrait_lancer_PostNotFound() {
      when(forumRepository.findById(6)).thenReturn(Optional.of(forum(6, "Thread")));

      assertThatThrownBy(() -> forumService.deletePost(6, 8, null))
          .isInstanceOf(PostNotFoundException.class);
    }
  }
}
