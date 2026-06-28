package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

/** Type de question (table Q_Type) : `id` (persistance), `slug` (discriminant front), `label` (FR). */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class QuestionTypeDTO {
    private Integer id;
    private String slug;
    private String label;
}
