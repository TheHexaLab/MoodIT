package com.moodit.auth_service.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class RegisterRequest {

  @NotBlank(message = "Le nom d'utilisateur est requis")
  @Size(min = 3, max = 64)
  private String username;

  @NotBlank(message = "Le prénom est requis")
  @Size(max = 128)
  private String firstName;

  @NotBlank(message = "Le nom est requis")
  @Size(max = 128)
  private String lastName;

  @NotBlank(message = "L'email est requis")
  @Email(message = "Format d'email invalide")
  private String email;

  @NotBlank(message = "Le mot de passe est requis")
  @Size(min = 8, message = "Le mot de passe doit avoir au moins 8 caractères")
  private String password;
}
