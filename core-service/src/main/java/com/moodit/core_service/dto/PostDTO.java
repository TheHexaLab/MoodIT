package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.LocalDateTime;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PostDTO {
    private Integer id;
    private LocalDateTime createdAt;
    private String content;
    /** Titre d'un sujet racine de forum 'Thread' (null sinon). */
    private String title;
    private Boolean isPinned;
}
