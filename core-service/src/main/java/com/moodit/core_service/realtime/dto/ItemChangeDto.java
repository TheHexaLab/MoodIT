// Modification d'une section diffusée en temps réel. Miroir de l'union TS
// `ItemChange` (SectionEditorPopup/types.ts) :
//   create  → { type, item }
//   rename  → { type, id, name }
//   delete  → { type, id }
//   reorder → { type, orderedIds }
// Les champs nuls sont omis (NON_NULL) pour ne produire que la forme du `type`.

package com.moodit.core_service.realtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ItemChangeDto(
    String type, ItemDto item, String id, String name, List<String> orderedIds) {

  public static ItemChangeDto create(ItemDto item) {
    return new ItemChangeDto("create", item, null, null, null);
  }

  public static ItemChangeDto rename(String id, String name) {
    return new ItemChangeDto("rename", null, id, name, null);
  }

  public static ItemChangeDto delete(String id) {
    return new ItemChangeDto("delete", null, id, null, null);
  }

  public static ItemChangeDto reorder(List<String> orderedIds) {
    return new ItemChangeDto("reorder", null, null, null, orderedIds);
  }
}
