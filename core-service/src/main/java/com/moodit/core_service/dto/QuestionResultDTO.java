package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

/** Résultat corrigé d'UNE question (vérité serveur). */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class QuestionResultDTO {
    private Integer questionId;
    private Double earned;
    private Double max;
    /** Choix : ids corrects / ids choisis. */
    private List<Integer> correctAnswerIds;
    private List<Integer> selectedAnswerIds;
    /** Remise en ordre : ordre attendu / ordre soumis. */
    private List<Integer> correctOrder;
    private List<Integer> submittedOrder;
    /** Association : détail par élément. */
    private List<MatchingItemResultDTO> matching;
    /** Code : source réellement soumise par l'étudiant (affichée en révision). */
    private String submittedCode;
    /** Code : non corrigé côté serveur → null. */
    private List<Object> tests;
}
