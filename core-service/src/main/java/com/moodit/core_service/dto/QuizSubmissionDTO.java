package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

/** Charge utile de soumission d'une tentative de quiz. */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class QuizSubmissionDTO {
    private Integer quizId;
    private List<SubmittedAnswerDTO> answers;
}
