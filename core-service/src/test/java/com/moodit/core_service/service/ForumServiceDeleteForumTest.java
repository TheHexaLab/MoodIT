package com.moodit.core_service.service;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.core_service.model.Forum;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.PostRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.repository.VoteRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;

/** Supprimer un forum signale sa suppression (le vocal ferme alors le salon LiveKit associé). */
class ForumServiceDeleteForumTest {

  @Test
  void deleteForumPublishesForumsDeletedEvent() {
    ForumRepository forumRepository = mock(ForumRepository.class);
    ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    ForumService service =
        new ForumService(
            forumRepository,
            mock(PostRepository.class),
            mock(VoteRepository.class),
            mock(UserRepository.class),
            mock(RealtimeEventPublisher.class),
            mock(AuditLogService.class),
            events);
    Forum forum = new Forum();
    forum.setId(42);
    when(forumRepository.findById(42)).thenReturn(Optional.of(forum));

    service.deleteForum(42);

    verify(forumRepository).delete(forum);
    verify(events).publishEvent(new ForumsDeletedEvent(List.of(42)));
  }
}
