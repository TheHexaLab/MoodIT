package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

/** Détail de correction d'un item d'Association (écran de révision). */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class MatchingItemResultDTO {
    private Integer itemId;
    private String chosenGroup;
    private String correctGroup;
    private Boolean correct;
}
