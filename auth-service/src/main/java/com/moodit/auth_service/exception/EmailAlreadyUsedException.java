// Levée quand l'adresse email est déjà associée à un compte (HTTP 409).

package com.moodit.auth_service.exception;

public class EmailAlreadyUsedException extends RuntimeException {
  public EmailAlreadyUsedException() {
    super("Cette adresse email est déjà utilisé");
  }
}
