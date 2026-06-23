// Message d'un canal 'Discussion' diffusé en temps réel.
// Doit renvoyer le même `client_msg_id` que celui reçu au POST pour que le front
// déduplique l'écho de son propre message optimiste (voir useChannelMessages).

package com.moodit.core_service.realtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ChannelMessageDto(
    long id,
    String content,
    String createdAt,
    Author author,
    Long postParentId,
    String clientMsgId) {}
