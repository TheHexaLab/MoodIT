package com.moodit.core_service.dto;

import java.util.List;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class CourseDTO {
    private Integer id;
    private String title;
    private String code;
    /**
     * Programmes auxquels le cours est rattaché. Renseigné seulement par GET /courses/{id} (le popup
     * « Modifier le cours » en a besoin pour pré-remplir la sélection) ; null dans les listes.
     */
    private List<Integer> programIds;
}
