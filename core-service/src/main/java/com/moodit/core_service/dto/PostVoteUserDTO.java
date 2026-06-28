package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@JsonPropertyOrder({"id", "title", "content", "createdAt", "isPinned", "postParentId", "userId", "author", "voteTotalValue", "childrenCount", "children"})
public class PostVoteUserDTO extends PostDTO{
    private Integer voteTotalValue;
    private Integer userId;
    /** Id du post parent (réponse) ; null pour un message/sujet racine. */
    private Integer postParentId;
    /** Auteur embarqué (le front attend message.author : id, username, prénom/nom, avatarColor). */
    private UserDTO author;
    private Integer childrenCount;
    private List<PostVoteUserDTO> children;
}
