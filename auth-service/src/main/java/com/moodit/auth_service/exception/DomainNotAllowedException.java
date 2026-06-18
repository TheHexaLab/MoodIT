package com.moodit.auth_service.exception;

public class DomainNotAllowedException extends RuntimeException {
  public DomainNotAllowedException() {
    super("Ce domaine courriel n'appartient à aucun établissement autorisé.");
  }
}
