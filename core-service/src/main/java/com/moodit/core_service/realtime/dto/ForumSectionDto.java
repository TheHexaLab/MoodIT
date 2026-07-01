// Forum embarqué dans un cours (sections « Discussion » / « Thread »), distingué
// par f_type ('Discussion' = canal de chat, 'Thread' = posts + réponses).

package com.moodit.core_service.realtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ForumSectionDto(long id, String title, String fType, Integer position) {}
