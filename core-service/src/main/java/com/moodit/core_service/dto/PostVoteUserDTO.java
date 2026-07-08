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
@JsonPropertyOrder({"id", "title", "content", "createdAt", "isPinned", "postParentId", "userId", "author", "voteTotalValue", "userVoteValue", "childrenCount", "children"})
public class PostVoteUserDTO extends PostDTO{
    private Integer voteTotalValue;
    /** Vote de l'UTILISATEUR COURANT sur ce post : 1, -1, ou null s'il n'a pas voté.
     *  Distinct de voteTotalValue (somme de TOUS les votes) : sert au front à surligner
     *  le bouton up/down que l'utilisateur a lui-même activé. */
    private Integer userVoteValue;
    private Integer userId;
    /** Id du post parent (réponse) ; null pour un message/sujet racine. */
    private Integer postParentId;
    /** Auteur embarqué (le front attend message.author : id, username, prénom/nom, avatarColor). */
    private UserDTO author;
    private Integer childrenCount;
    private List<PostVoteUserDTO> children;
}
