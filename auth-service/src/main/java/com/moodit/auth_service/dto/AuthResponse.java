// DTO de réponse d'authentification renvoyé au client (token JWT + infos utilisateur).

package com.moodit.auth_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class AuthResponse {

  private String token;
  private String username;
  private String email;
  private String firstName;
  private String lastName;
}
