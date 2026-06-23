// Levée quand un code de vérification (email ou 2FA) est invalide ou expiré (HTTP 400).

package com.moodit.auth_service.exception;

public class InvalidVerificationCodeException extends RuntimeException {
  public InvalidVerificationCodeException(String message) {
    super(message);
  }
}
