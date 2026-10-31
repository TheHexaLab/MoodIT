package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.ForumUpdatePostDTO;
import com.moodit.core_service.dto.PostCreateInForumDTO;
import com.moodit.core_service.dto.PostDTO;
import com.moodit.core_service.dto.PostVoteUserDTO;
import com.moodit.core_service.exception.InvalidPostException;
import com.moodit.core_service.model.FType;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.model.Post;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.PostRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.repository.VoteRepository;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/** Canal d'annonces : création d'une annonce et filtrage des annonces expirées. */
class ForumServiceAnnouncementTest {

  private static final String EMAIL = "prof@test.ca";

  private ForumService service;
  private ForumRepository forumRepository;
  private PostRepository postRepository;
  private UserRepository userRepository;
  private RealtimeEventPublisher realtime;
  private Forum announcements;

  @BeforeEach
  void setUp() {
    forumRepository = mock(ForumRepository.class);
    postRepository = mock(PostRepository.class);
    userRepository = mock(UserRepository.class);
    realtime = mock(RealtimeEventPublisher.class);
    service =
        new ForumService(
            forumRepository,
            postRepository,
            mock(VoteRepository.class),
            userRepository,
            realtime,
            mock(AuditLogService.class));

    FType type = new FType();
    type.setId(3);
    type.setName("Announcement");
    announcements = new Forum();
    announcements.setId(11);
    announcements.setFType(type);
    when(forumRepository.findById(11)).thenReturn(Optional.of(announcements));

    User prof = new User();
    prof.setId(2);
    prof.setEmail(EMAIL);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(prof));
    when(postRepository.saveAndFlush(any()))
        .thenAnswer(
            inv -> {
              Post p = inv.getArgument(0);
              p.setId(100);
              return p;
            });
  }

  private PostCreateInForumDTO announcement(String title, String content, String color) {
    return PostCreateInForumDTO.builder()
        .forumId(11)
        .title(title)
        .content(content)
        .color(color)
        .build();
  }

  @Test
  void annonce_sansTexte_couleurEtExpiration_enregistrees() {
    PostCreateInForumDTO dto = announcement("Examen déplacé", "", "red");
    dto.setExpiresAt(Instant.parse("2026-11-05T05:00:00Z"));

    PostVoteUserDTO created = service.addPostToForum(dto, EMAIL);

    ArgumentCaptor<Post> saved = ArgumentCaptor.forClass(Post.class);
    verify(postRepository).saveAndFlush(saved.capture());
    assertThat(saved.getValue().getContent()).isEmpty();
    assertThat(saved.getValue().getColor()).isEqualTo("red");
    assertThat(saved.getValue().getExpiresAt()).isEqualTo(LocalDateTime.of(2026, 11, 5, 5, 0));
    assertThat(created.getColor()).isEqualTo("red");
    assertThat(created.getExpiresAt()).isEqualTo(Instant.parse("2026-11-05T05:00:00Z"));
  }

  @Test
  void annonce_sansCouleur_bleuParDefaut_etSansExpiration() {
    service.addPostToForum(announcement("Bienvenue", "Bon début de session", null), EMAIL);

    ArgumentCaptor<Post> saved = ArgumentCaptor.forClass(Post.class);
    verify(postRepository).saveAndFlush(saved.capture());
    assertThat(saved.getValue().getColor()).isEqualTo("blue");
    assertThat(saved.getValue().getExpiresAt()).isNull();
  }

  @Test
  void annonce_sansCouleurNiTexte_creeeEnBleu() {
    service.addPostToForum(announcement("Bienvenue", null, null), EMAIL);

    ArgumentCaptor<Post> saved = ArgumentCaptor.forClass(Post.class);
    verify(postRepository).saveAndFlush(saved.capture());
    assertThat(saved.getValue().getContent()).isEmpty();
    assertThat(saved.getValue().getColor()).isEqualTo("blue");
  }

  @Test
  void annonce_titreTropLong_refusee() {
    String tooLong = "a".repeat(ForumService.MAX_TITLE_LENGTH + 1);
    assertThatThrownBy(() -> service.addPostToForum(announcement(tooLong, "", "blue"), EMAIL))
        .isInstanceOf(InvalidPostException.class);
  }

  @Test
  void annonce_sansTitre_refusee() {
    assertThatThrownBy(() -> service.addPostToForum(announcement("  ", "texte", "blue"), EMAIL))
        .isInstanceOf(InvalidPostException.class);
    verify(postRepository, never()).saveAndFlush(any());
  }

  @Test
  void annonce_couleurInconnue_refusee() {
    assertThatThrownBy(() -> service.addPostToForum(announcement("Titre", "", "#ff00ff"), EMAIL))
        .isInstanceOf(InvalidPostException.class);
  }

  @Test
  void annonce_texteTropLong_refusee() {
    String tooLong = "a".repeat(ForumService.MAX_CONTENT_LENGTH + 1);
    assertThatThrownBy(() -> service.addPostToForum(announcement("Titre", tooLong, "blue"), EMAIL))
        .isInstanceOf(InvalidPostException.class);
  }

  @Test
  void reponseAUneAnnonce_refusee() {
    PostCreateInForumDTO reply = announcement("Titre", "Merci !", "blue");
    reply.setParentPostId(100);
    assertThatThrownBy(() -> service.addPostToForum(reply, EMAIL))
        .isInstanceOf(InvalidPostException.class);
  }

  @Test
  void forumOrdinaire_avecCouleur_texteVideRefuse() {
    FType thread = new FType();
    thread.setName("Thread");
    Forum forum = new Forum();
    forum.setId(6);
    forum.setFType(thread);
    when(forumRepository.findById(6)).thenReturn(Optional.of(forum));

    PostCreateInForumDTO dto = PostCreateInForumDTO.builder().forumId(6).title("T").content(" ").color("red").build();

    assertThatThrownBy(() -> service.addPostToForum(dto, EMAIL)).isInstanceOf(InvalidPostException.class);
  }

  private Post existing() {
    Post p = new Post();
    p.setId(40);
    p.setTitle("Ancien");
    p.setContent("vieux texte");
    p.setColor("red");
    p.setExpiresAt(LocalDateTime.of(2026, 11, 1, 0, 0));
    p.setForum(announcements);
    when(postRepository.findByIdAndForumId(40, 11)).thenReturn(Optional.of(p));
    return p;
  }

  @Test
  void modification_complete_clearExpiresAtRetireLExpiration() {
    Post p = existing();
    ForumUpdatePostDTO dto =
        ForumUpdatePostDTO.builder().title("Nouveau").content("").color("green").clearExpiresAt(true).build();

    PostDTO out = service.updatePost(11, 40, dto);

    assertThat(p.getTitle()).isEqualTo("Nouveau");
    assertThat(p.getContent()).isEmpty();
    assertThat(p.getColor()).isEqualTo("green");
    assertThat(p.getExpiresAt()).isNull();
    assertThat(out.getColor()).isEqualTo("green");
    verify(realtime).postEdited(11L, 40L, "", "Nouveau", "green", null);
  }

  @Test
  void modification_partielle_titreSeul_gardeTexteEtExpiration() {
    Post p = existing();

    service.updatePost(11, 40, ForumUpdatePostDTO.builder().title("Renommée").build());

    assertThat(p.getTitle()).isEqualTo("Renommée");
    assertThat(p.getContent()).isEqualTo("vieux texte");
    assertThat(p.getColor()).isEqualTo("red");
    assertThat(p.getExpiresAt()).isEqualTo(LocalDateTime.of(2026, 11, 1, 0, 0));
  }

  @Test
  void modification_partielle_isPinnedSeul_neTouchePasAuReste() {
    Post p = existing();

    service.updatePost(11, 40, ForumUpdatePostDTO.builder().isPinned(true).build());

    assertThat(p.getIsPinned()).isTrue();
    assertThat(p.getTitle()).isEqualTo("Ancien");
    assertThat(p.getContent()).isEqualTo("vieux texte");
    assertThat(p.getExpiresAt()).isEqualTo(LocalDateTime.of(2026, 11, 1, 0, 0));
    verify(realtime, never()).postEdited(anyLong(), anyLong(), any(), any(), any(), any());
  }

  @Test
  void modification_titreTropLong_refusee() {
    existing();
    String tooLong = "a".repeat(ForumService.MAX_TITLE_LENGTH + 1);

    assertThatThrownBy(() -> service.updatePost(11, 40, ForumUpdatePostDTO.builder().title(tooLong).build()))
        .isInstanceOf(InvalidPostException.class);
  }

  @Test
  void modification_nouvelleExpiration_etCouleurConservee() {
    Post p = existing();
    ForumUpdatePostDTO dto =
        ForumUpdatePostDTO.builder()
            .title("Titre")
            .content("texte")
            .expiresAt(Instant.parse("2026-12-01T04:59:59Z"))
            .build();

    service.updatePost(11, 40, dto);

    assertThat(p.getColor()).isEqualTo("red");
    assertThat(p.getExpiresAt()).isEqualTo(LocalDateTime.of(2026, 12, 1, 4, 59, 59));
  }

  @Test
  void modification_sansTitre_refusee() {
    existing();
    ForumUpdatePostDTO dto = ForumUpdatePostDTO.builder().title(" ").content("x").build();

    assertThatThrownBy(() -> service.updatePost(11, 40, dto)).isInstanceOf(InvalidPostException.class);
  }

  @Test
  void liste_parDefaut_sansLesAnnoncesExpirees() {
    when(postRepository.findUnexpiredRootPostsPage(eq(11), eq(null), any(), any())).thenReturn(List.of());

    service.getRootPostsPage(11, null, 20, false, false, EMAIL);

    verify(postRepository).findUnexpiredRootPostsPage(eq(11), eq(null), any(), any());
    verify(postRepository, never()).findRootPostsPage(any(), any(), any());
  }

  @Test
  void liste_includeExpired_toutesLesAnnonces() {
    when(postRepository.findRootPostsPage(eq(11), eq(null), any())).thenReturn(List.of());

    service.getRootPostsPage(11, null, 20, false, true, EMAIL);

    verify(postRepository).findRootPostsPage(eq(11), eq(null), any());
    verify(postRepository, never()).findUnexpiredRootPostsPage(any(), any(), any(), any());
  }
}
