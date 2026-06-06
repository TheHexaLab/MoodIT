package com.moodit.auth_service.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;
import jakarta.validation.constraints.Pattern;

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
  @Pattern(
      regexp =
          "^(?=.*[0-9])(?=.*[!@#$%^&*()_+\\\\-=\\\\[\\\\]{};':\\\"\\\\\\\\|,.<>\\\\/?]).{10,}$",
      message =
          "Le mot de passe doit contenir au moins 10 caractères, 1 chiffre et 1 caractère spécial")
  private String password;
}
