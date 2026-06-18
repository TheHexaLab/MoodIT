package com.moodit.auth_service.exception;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

  @ExceptionHandler(EmailAlreadyUsedException.class)
  public ResponseEntity<Map<String, String>> handleEmailAlreadyUsed(EmailAlreadyUsedException ex) {
    return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("message", ex.getMessage()));
  }

  @ExceptionHandler(UsernameAlreadyUsedException.class)
  public ResponseEntity<Map<String, String>> handleUsernameAlreadyUsed(
      UsernameAlreadyUsedException ex) {
    return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("message", ex.getMessage()));
  }

  @ExceptionHandler(InvalidCredentialsException.class)
  public ResponseEntity<Map<String, String>> handleInvalidCredentials(
      InvalidCredentialsException ex) {
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("message", ex.getMessage()));
  }

  @ExceptionHandler(EmailNotVerifiedException.class)
  public ResponseEntity<Map<String, String>> handleEmailNotVerified(EmailNotVerifiedException ex) {
    return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("message", ex.getMessage()));
  }

  @ExceptionHandler(InvalidVerificationCodeException.class)
  public ResponseEntity<Map<String, String>> handleInvalidVerificationCode(
      InvalidVerificationCodeException ex) {
    return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("message", ex.getMessage()));
  }

  @ExceptionHandler(TooManyRequestsException.class)
  public ResponseEntity<Map<String, String>> handleTooManyRequests(TooManyRequestsException ex) {
    return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
        .body(Map.of("message", ex.getMessage()));
  }

  @ExceptionHandler(DomainNotAllowedException.class)
  public ResponseEntity<Map<String, String>> handleDomainNotAllowed(DomainNotAllowedException ex) {
    return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("message", ex.getMessage()));
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<Map<String, String>> handleValidation(MethodArgumentNotValidException ex) {
    String message =
        ex.getBindingResult().getFieldErrors().stream()
            .map(e -> e.getDefaultMessage())
            .findFirst()
            .orElse("Données invalides");
    return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("message", message));
  }
}
