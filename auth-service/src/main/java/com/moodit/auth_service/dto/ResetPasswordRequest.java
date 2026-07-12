// DTO de la réinitialisation effective : email + code reçu par courriel + nouveau mot de passe.

package com.moodit.auth_service.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class ResetPasswordRequest {

  @NotBlank(message = "L'email est requis")
  @Email(message = "Format d'email invalide")
  private String email;

  @NotBlank(message = "Le code est requis")
  @Pattern(regexp = "\\d{6}", message = "Le code doit contenir 6 chiffres")
  private String code;

  // Mêmes règles que RegisterRequest.password (cohérence des exigences de mot de passe).
  @NotBlank(message = "Le mot de passe est requis")
  @Size(min = 8, max = 128, message = "Le mot de passe doit contenir entre 8 et 128 caractères")
  private String newPassword;
}
