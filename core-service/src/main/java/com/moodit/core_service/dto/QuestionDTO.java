package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
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
@JsonPropertyOrder({"id", "prompt", "qType", "qTypeId", "totalScore", "orderIndex", "language", "startCode", "answers", "dragItems", "testCases"})
public class QuestionDTO {
    private Integer id;
    private String prompt;
    private String qType;
    private Integer qTypeId;
    private Integer totalScore;
    private Integer orderIndex;
    /** Langage d'exécution (questions Code) : light (id+name) en lecture, id lu à l'écriture. */
    private LanguageDTO language;
    private String startCode;
    private List<AnswerDTO> answers;
    private List<DragItemDTO> dragItems;
    /**
     * Harnais de test (questions Code). Présent UNIQUEMENT pour l'éditeur enseignant ; en
     * PASSATION on laisse null → omis du JSON pour ne pas divulguer le code des tests.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private List<TestCaseDTO> testCases;
}
