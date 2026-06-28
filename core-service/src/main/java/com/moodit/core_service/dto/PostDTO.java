package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.Instant;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PostDTO {
    private Integer id;
    /** Instant UTC (sérialisé avec 'Z') : le front le convertit en heure locale. */
    private Instant createdAt;
    private String content;
    /** Titre d'un sujet racine de forum 'Thread' (null sinon). */
    private String title;
    private Boolean isPinned;
}
