package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;
import java.util.Map;

/** Réponse de l'étudiant à UNE question (forme normalisée par famille de type). */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class SubmittedAnswerDTO {
    private Integer questionId;
    /** Choix : ids des options cochées. */
    private List<Integer> answerIds;
    /** Remise en ordre : ids des éléments dans l'ordre soumis. */
    private List<Integer> orderedItemIds;
    /** Association : placement dragItemId → groupName (null = non classé). */
    private Map<Integer, String> placement;
    /** Code : source soumise (non corrigé côté serveur). */
    private String code;
}
