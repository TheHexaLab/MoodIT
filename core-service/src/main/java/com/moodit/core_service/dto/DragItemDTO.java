package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

/** Élément déplaçable (table Drag_Item) pour le détail d'un quiz (ordering / matching). */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class DragItemDTO {
    private Integer id;
    private String content;
    /**
     * Position correcte (ordering) et bon groupe d'association (matching). Présents
     * UNIQUEMENT pour l'éditeur enseignant ; laissés null en PASSATION → omis du JSON
     * (@JsonInclude NON_NULL) pour ne pas divulguer la correction à l'étudiant.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer correctOrder;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private String groupName;
}
