// Auteur d'un message / post poussé en temps réel (sous-ensemble de User_).
// Forme JSON snake_case attendue par le front (types/domain.ts → User).

package com.moodit.core_service.realtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record Author(
    long id,
    String username,
    String firstName,
    String lastName,
    String avatarColor) {

  public Author(long id, String username, String firstName, String lastName) {
    this(id, username, firstName, lastName, null);
  }
}
