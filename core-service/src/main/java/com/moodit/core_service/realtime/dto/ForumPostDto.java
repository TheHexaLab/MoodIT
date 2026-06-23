// Sujet ou réponse d'un forum 'Thread' diffusé en temps réel.
// Comme le chat, renvoyer `client_post_id` pour la déduplication optimiste ↔ écho.

package com.moodit.core_service.realtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ForumPostDto(
    long id,
    String content,
    String createdAt,
    Author author,
    Boolean isPinned,
    String title,
    List<PostVoteDto> votes,
    List<ForumPostDto> replies,
    Integer replyCount,
    String clientPostId) {}
