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
@JsonPropertyOrder({"id", "prompt", "qType", "qTypeId", "totalScore", "orderIndex", "language", "startCode", "answers", "dragItems", "groups", "testCases"})
public class QuestionDTO {
    private Integer id;
    private String prompt;
    private String qType;
    private Integer qTypeId;
    private Double totalScore;
    private Integer orderIndex;
    /** Langage d'exécution (questions Code) : light (id+name) en lecture, id lu à l'écriture. */
    private LanguageDTO language;
    private String startCode;
    private List<AnswerDTO> answers;
    private List<DragItemDTO> dragItems;
    /**
     * Catégories d'une question d'association (zones de dépôt) = groupes DISTINCTS. Exposé à
     * l'étudiant (il doit voir les zones), CONTRAIREMENT au groupe correct de CHAQUE item
     * (DragItemDTO.groupName, masqué en passation pour ne pas divulguer la réponse).
     */
    private List<String> groups;
    /**
     * Harnais de test (questions Code). Présent UNIQUEMENT pour l'éditeur enseignant ; en
     * PASSATION on laisse null → omis du JSON pour ne pas divulguer le code des tests.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private List<TestCaseDTO> testCases;
}
