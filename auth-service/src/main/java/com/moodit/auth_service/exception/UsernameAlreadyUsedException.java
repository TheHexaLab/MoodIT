package com.moodit.auth_service.exception;

public class UsernameAlreadyUsedException extends RuntimeException {
  public UsernameAlreadyUsedException() {
    super("Ce nom d'utilisateur est déjà pris");
  }
}
