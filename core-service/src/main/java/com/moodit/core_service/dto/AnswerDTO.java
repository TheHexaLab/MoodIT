package com.moodit.core_service.dto;

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
    private Boolean isCorrect;
}
