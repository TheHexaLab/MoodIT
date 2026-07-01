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
@JsonPropertyOrder({"id", "title", "position", "isPublished", "isDaily", "allowRetry", "questionCount", "createdAt"})
public class QuizDTO {
    private Integer id;
    private String title;
    private Integer position;
    private Boolean isPublished;
    private Boolean isDaily;
    /** L'étudiant peut-il refaire le quiz ? */
    private Boolean allowRetry;
    /** Nombre de questions (vues de liste : sans charger les questions). */
    private Integer questionCount;
    private LocalDateTime createdAt;
}
