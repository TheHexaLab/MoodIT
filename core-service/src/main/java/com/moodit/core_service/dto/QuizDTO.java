package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.LocalDateTime;

/** Méta d'un quiz pour les vues de LISTE (sans les questions). */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@JsonPropertyOrder({"id", "title", "position", "isPublished", "isDaily", "createdAt"})
public class QuizDTO {
    private Integer id;
    private String title;
    private Integer position;
    private Boolean isPublished;
    private Boolean isDaily;
    private LocalDateTime createdAt;
}
