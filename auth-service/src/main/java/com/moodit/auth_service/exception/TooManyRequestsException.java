// Levée quand le cooldown ou le plafond d'envoi de codes est dépassé (HTTP 429).

package com.moodit.auth_service.exception;

public class TooManyRequestsException extends RuntimeException {
  public TooManyRequestsException(String message) {
    super(message);
  }
}
