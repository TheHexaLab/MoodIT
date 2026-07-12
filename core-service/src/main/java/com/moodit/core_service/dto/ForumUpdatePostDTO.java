package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class ForumUpdatePostDTO {
    private String content;
    /** Titre d'un sujet racine de forum 'Thread' (null pour une réponse / un message). */
    private String title;
    private Boolean isPinned;
}
