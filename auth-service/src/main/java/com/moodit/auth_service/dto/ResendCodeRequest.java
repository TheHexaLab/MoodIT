// DTO d'une demande de renvoi de code (email + mode "email" ou "2fa"), avec validation.

package com.moodit.auth_service.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import lombok.Data;

@Data
public class ResendCodeRequest {

  @NotBlank(message = "L'email est requis")
  @Email(message = "Format d'email invalide")
  private String email;

  // "2fa" = renvoi du code de connexion ; sinon (y compris null) = code d'inscription.
  @Pattern(regexp = "2fa|email", message = "Mode invalide")
  private String mode;
}
