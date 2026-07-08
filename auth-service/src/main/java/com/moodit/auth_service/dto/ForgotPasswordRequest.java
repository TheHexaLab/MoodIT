// DTO de la demande de réinitialisation (saisie de l'email uniquement).

package com.moodit.auth_service.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class ForgotPasswordRequest {

  @NotBlank(message = "L'email est requis")
  @Email(message = "Format d'email invalide")
  private String email;
}
