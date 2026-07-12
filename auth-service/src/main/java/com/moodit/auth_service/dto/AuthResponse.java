// DTO de réponse d'authentification renvoyé au client (infos utilisateur). Le token JWT
// n'est plus exposé dans le corps : il est posé en cookie HttpOnly par le contrôleur.
// Il transite encore ici en interne (service -> contrôleur) pour construire le cookie,
// mais @JsonInclude(NON_NULL) l'exclut de la sérialisation dès qu'il est remis à null.

package com.moodit.auth_service.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class AuthResponse {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  private String token;

  private String username;
  private String email;
  private String firstName;
  private String lastName;
}
