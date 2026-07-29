package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.moodit.core_service.dto.PostCreateInForumDTO;
import com.moodit.core_service.exception.InvalidPostException;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.PostRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.repository.VoteRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Validation de la limite de contenu (source de vérité de la limite alignée avec le front).
 * addPostToForum valide AVANT tout accès BD → tests unitaires purs (repositories mockés).
 */
class ForumServiceContentLimitTest {

  private ForumService service;
  private ForumRepository forumRepository;

  @BeforeEach
  void setUp() {
    forumRepository = mock(ForumRepository.class);
    service =
        new ForumService(
            forumRepository,
            mock(PostRepository.class),
            mock(VoteRepository.class),
            mock(UserRepository.class),
            mock(RealtimeEventPublisher.class),
            mock(AuditLogService.class));
  }

  private PostCreateInForumDTO dto(String content) {
    PostCreateInForumDTO d = new PostCreateInForumDTO();
    d.setContent(content);
    d.setForumId(1);
    return d;
  }

  @Test
  void addPost_contentTooLong_rejected() {
    String tooLong = "a".repeat(ForumService.MAX_CONTENT_LENGTH + 1);
    assertThatThrownBy(() -> service.addPostToForum(dto(tooLong), "u@test.ca"))
        .isInstanceOf(InvalidPostException.class);
    verifyNoInteractions(forumRepository); // rejeté AVANT tout accès BD
  }

  @Test
  void addPost_blank_rejected() {
    assertThatThrownBy(() -> service.addPostToForum(dto("   "), "u@test.ca"))
        .isInstanceOf(InvalidPostException.class);
  }

  @Test
  void addPost_atLimit_passesContentValidation() {
    // Exactement la limite : la validation de CONTENU passe (l'échec suivant vient du forum
    // introuvable, pas de la longueur) → prouve que la borne MAX est inclusive.
    String atLimit = "a".repeat(ForumService.MAX_CONTENT_LENGTH);
    assertThatThrownBy(() -> service.addPostToForum(dto(atLimit), "u@test.ca"))
        .isNotInstanceOf(InvalidPostException.class);
  }
}
