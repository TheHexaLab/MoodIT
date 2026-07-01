package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

/** Résultat corrigé d'une tentative complète. */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class QuizResultDTO {
    private Integer quizId;
    /** Tentative correspondant à ce résultat (null avant persistance, sinon renseigné). */
    private Integer attemptId;
    private Integer attemptNo;
    private Integer earned;
    private Integer max;
    private List<QuestionResultDTO> questions;
}
