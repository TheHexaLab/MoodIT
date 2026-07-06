package com.moodit.core_service.dto;

import com.moodit.core_service.realtime.dto.ItemChangeDto;
import lombok.Data;

/**
 * Corps de PATCH /courses/{courseId}/sections : une modification de section (canal 'text' /
 * forum). `change` reprend exactement l'union `ItemChange` du front (create/rename/delete/
 * reorder), désérialisée dans le record realtime {@link ItemChangeDto}.
 */
@Data
public class SectionChangeRequest {
    /** 'text' (canal 'Discussion') ou 'forum' ('Thread'). */
    private String sectionType;
    private ItemChangeDto change;
}
