// Cours poussé en temps réel (scope = programme). `channels` reste présent pour
// coller à la forme attendue côté front (Course), même si les canaux de chat sont
// modélisés comme des forums 'Discussion'.

package com.moodit.core_service.realtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record CourseDto(
    long id,
    String code,
    String title,
    List<ForumSectionDto> channels,
    List<QuizSectionDto> quizzes,
    List<ForumSectionDto> forums) {

  /** Cours « nu » (sans sections chargées) : listes vides plutôt que null. */
  public static CourseDto of(long id, String code, String title) {
    return new CourseDto(id, code, title, List.of(), List.of(), List.of());
  }
}
