// Levée quand l'email est inconnu ou le mot de passe incorrect (HTTP 401).

package com.moodit.auth_service.exception;

public class InvalidCredentialsException extends RuntimeException {
  public InvalidCredentialsException() {
    super("Email ou mot de passe invalide");
  }
}
