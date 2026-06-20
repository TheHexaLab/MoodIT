// Contrôleur REST de l'authentification : register, login, validate, vérification email/2FA, renvoi de code.

package com.moodit.auth_service.controller;

import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.LoginRequest;
import com.moodit.auth_service.dto.RegisterRequest;
import com.moodit.auth_service.dto.ResendCodeRequest;
import com.moodit.auth_service.dto.VerifyCodeRequest;
import com.moodit.auth_service.service.AuthService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/auth")
@RequiredArgsConstructor
public class AuthController {

  private final AuthService authService;

  @PostMapping("/register")
  public ResponseEntity<Map<String, String>> register(@Valid @RequestBody RegisterRequest request) {
    return ResponseEntity.ok(authService.register(request));
  }

  @PostMapping("/login")
  public ResponseEntity<AuthResponse> login(@Valid @RequestBody LoginRequest request) {
    return ResponseEntity.ok(authService.login(request));
  }

  @PostMapping("/validate")
  public ResponseEntity<Boolean> validate(
      @RequestHeader(value = "Authorization", required = false) String authHeader) {
    // Retire uniquement le préfixe "Bearer " (cohérent avec le gateway, JwtAuthFilter).
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      return ResponseEntity.ok(false);
    }
    return ResponseEntity.ok(authService.validate(authHeader.substring(7)));
  }

  @PostMapping("/verify-email")
  public ResponseEntity<Map<String, String>> verifyEmail(
      @Valid @RequestBody VerifyCodeRequest req) {
    return ResponseEntity.ok(authService.verifyEmail(req.getEmail(), req.getCode()));
  }

  @PostMapping("/verify-2fa")
  public ResponseEntity<AuthResponse> verify2FA(@Valid @RequestBody VerifyCodeRequest req) {
    return ResponseEntity.ok(authService.verify2FA(req.getEmail(), req.getCode()));
  }

  @PostMapping("/resend-code")
  public ResponseEntity<Map<String, String>> resendCode(
      @Valid @RequestBody ResendCodeRequest req) {
    return ResponseEntity.ok(authService.resendCode(req.getEmail(), req.getMode()));
  }
}
