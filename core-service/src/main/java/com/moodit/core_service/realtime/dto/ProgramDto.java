// Programme poussé en temps réel (scope = utilisateur). `courses` optionnel :
// omis pour un simple renommage, présent si l'évènement embarque les cours.

package com.moodit.core_service.realtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProgramDto(
    long id,
    String name,
    String code,
    String cohort,
    String color,
    List<CourseDto> courses) {

  public ProgramDto(long id, String name, String code, String cohort, String color) {
    this(id, name, code, cohort, color, null);
  }
}
