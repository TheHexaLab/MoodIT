package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

/** Détail complet d'un quiz (méta + questions embarquées) pour la passation/édition. */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@JsonPropertyOrder({"id", "title", "position", "isPublished", "isDaily", "allowRetry", "questions"})
public class QuizDetailDTO {
    private Integer id;
    private String title;
    private Integer position;
    private Boolean isPublished;
    private Boolean isDaily;
    /** L'étudiant peut-il refaire le quiz ? */
    private Boolean allowRetry;
    private List<QuestionDTO> questions;
}
