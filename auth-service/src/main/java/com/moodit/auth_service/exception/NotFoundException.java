// Levée quand une ressource demandée est introuvable (HTTP 404).

package com.moodit.auth_service.exception;

public class NotFoundException extends RuntimeException {
  public NotFoundException(String message) {
    super(message);
  }
}
