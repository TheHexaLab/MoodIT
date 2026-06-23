// DTO d'une requête de vérification par code (email + code à 6 chiffres), avec validation.

package com.moodit.auth_service.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import lombok.Data;

@Data
public class VerifyCodeRequest {

  @NotBlank(message = "L'email est requis")
  @Email(message = "Format d'email invalide")
  private String email;

  @NotBlank(message = "Le code est requis")
  @Pattern(regexp = "\\d{6}", message = "Le code doit contenir 6 chiffres")
  private String code;
}
