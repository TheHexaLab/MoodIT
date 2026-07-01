package com.moodit.core_service.dto;

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
    private Integer correctOrder;
    private String groupName;
}
