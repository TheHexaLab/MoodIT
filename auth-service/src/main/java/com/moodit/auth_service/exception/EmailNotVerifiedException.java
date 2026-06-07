package com.moodit.auth_service.exception;

public class EmailNotVerifiedException extends RuntimeException {
  public EmailNotVerifiedException() {
    super("Veuillez vérifier votre email avant de vous connecter");
  }
}
