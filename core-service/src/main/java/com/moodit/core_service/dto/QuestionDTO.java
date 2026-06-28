package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

/**
 * Question d'un quiz pour la PASSATION/édition. `qType` est le slug attendu par le
 * front (discriminant), `qTypeId` la clé en base. Les harnais (Test_Case) ne sont
 * jamais inclus ici.
 */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@JsonPropertyOrder({"id", "prompt", "qType", "qTypeId", "totalScore", "orderIndex", "startCode", "answers", "dragItems"})
public class QuestionDTO {
    private Integer id;
    private String prompt;
    private String qType;
    private Integer qTypeId;
    private Integer totalScore;
    private Integer orderIndex;
    private String startCode;
    private List<AnswerDTO> answers;
    private List<DragItemDTO> dragItems;
}
