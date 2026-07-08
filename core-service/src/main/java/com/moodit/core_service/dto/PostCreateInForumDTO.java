package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PostCreateInForumDTO{
    private String content;
    /** Titre d'un sujet racine de forum 'Thread' (null pour une réponse / un message). */
    private String title;
    private Integer forumId;
    private Integer parentPostId;
    /**
     * Nonce d'idempotence renvoyé TEL QUEL dans l'évènement WebSocket `*:created`, pour que
     * le front déduplique l'écho de son propre message/post optimiste. Le front envoie
     * `clientPostId` (forum 'Thread') ou `clientMessageId` (canal 'Discussion') selon le cas.
     */
    private String clientPostId;
    private String clientMessageId;
}
