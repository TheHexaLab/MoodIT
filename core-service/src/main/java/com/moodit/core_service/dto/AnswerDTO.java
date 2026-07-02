package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

/** Option de réponse (table Answer) pour le détail d'un quiz. */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class AnswerDTO {
    private Integer id;
    private String content;
    /**
     * Bonne réponse ? Présent UNIQUEMENT pour l'éditeur enseignant. En PASSATION on
     * le laisse null → omis du JSON (@JsonInclude NON_NULL) pour ne pas divulguer la
     * correction à l'étudiant (la correction se fait côté serveur).
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Boolean isCorrect;
}
