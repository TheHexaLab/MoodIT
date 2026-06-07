package com.moodit.auth_service.exception;

public class InvalidCredentialsException extends RuntimeException {
  public InvalidCredentialsException() {
    super("Email ou mot de passe invalide");
  }
}
