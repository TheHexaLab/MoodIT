// Contrôleur REST de l'authentification : register, login, validate, vérification email/2FA, renvoi de code.

package com.moodit.auth_service.controller;

import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.LoginRequest;
import com.moodit.auth_service.dto.ForgotPasswordRequest;
import com.moodit.auth_service.dto.RegisterRequest;
import com.moodit.auth_service.dto.ResendCodeRequest;
import com.moodit.auth_service.dto.ResetPasswordRequest;
import com.moodit.auth_service.dto.VerifyCodeRequest;
import com.moodit.auth_service.config.AuthCookie;
import com.moodit.auth_service.service.AuthService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/auth")
@RequiredArgsConstructor
public class AuthController {

  private final AuthService authService;
  private final AuthCookie authCookie;

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
  public ResponseEntity<AuthResponse> verifyEmail(@Valid @RequestBody VerifyCodeRequest req) {
    // Auto-login après vérification de l'email : même réponse authentifiée que la 2FA.
    return authResponse(authService.verifyEmail(req.getEmail(), req.getCode()));
  }

  @PostMapping("/verify-2fa")
  public ResponseEntity<AuthResponse> verify2FA(@Valid @RequestBody VerifyCodeRequest req) {
    return authResponse(authService.verify2FA(req.getEmail(), req.getCode()));
  }

  // Réponse authentifiée : dépose le JWT en cookie HttpOnly (invisible au JS) et le retire du
  // corps JSON après coup — @JsonInclude(NON_NULL) l'exclut alors. Partagé par verify-email et
  // verify-2fa, les deux seuls points où une session naît.
  private ResponseEntity<AuthResponse> authResponse(AuthResponse body) {
    ResponseCookie cookie = authCookie.build(body.getToken());
    body.setToken(null);
    return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, cookie.toString()).body(body);
  }

  @PostMapping("/resend-code")
  public ResponseEntity<Map<String, String>> resendCode(
      @Valid @RequestBody ResendCodeRequest req) {
    return ResponseEntity.ok(authService.resendCode(req.getEmail(), req.getMode()));
  }

  @PostMapping("/forgot-password")
  public ResponseEntity<Map<String, String>> forgotPassword(
      @Valid @RequestBody ForgotPasswordRequest req) {
    return ResponseEntity.ok(authService.forgotPassword(req.getEmail()));
  }

  @PostMapping("/reset-password")
  public ResponseEntity<Map<String, String>> resetPassword(
      @Valid @RequestBody ResetPasswordRequest req) {
    return ResponseEntity.ok(
        authService.resetPassword(req.getEmail(), req.getCode(), req.getNewPassword()));
  }
}
