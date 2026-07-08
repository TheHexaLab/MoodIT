// Contrôleur REST de l'authentification : register, login, validate, vérification email/2FA, renvoi
// de code.

package com.moodit.auth_service.controller;

import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.LoginRequest;
import com.moodit.auth_service.dto.RegisterRequest;
import com.moodit.auth_service.dto.ResendCodeRequest;
import com.moodit.auth_service.dto.VerifyCodeRequest;
import com.moodit.auth_service.config.AuthCookie;
import com.moodit.auth_service.service.AuthService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
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
  public ResponseEntity<Map<String, String>> verifyEmail(
      @Valid @RequestBody VerifyCodeRequest req) {
    return ResponseEntity.ok(authService.verifyEmail(req.getEmail(), req.getCode()));
  }

  @PostMapping("/verify-2fa")
  public ResponseEntity<AuthResponse> verify2FA(@Valid @RequestBody VerifyCodeRequest req) {
    AuthResponse body = authService.verify2FA(req.getEmail(), req.getCode());
    // Le token est posé UNIQUEMENT en cookie HttpOnly (invisible au JS). On le retire du
    // corps après avoir construit le cookie : @JsonInclude(NON_NULL) l'exclut alors du JSON.
    ResponseCookie cookie = authCookie.build(body.getToken());
    body.setToken(null);
    return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, cookie.toString()).body(body);
  }

  @PostMapping("/logout")
  public ResponseEntity<Void> logout(HttpServletRequest request) {
    // Lit le JWT depuis le cookie HttpOnly pour révoquer la session côté serveur.
    authService.logout(extractTokenFromCookie(request));
    // Demande au navigateur de supprimer le cookie d'authentification.
    return ResponseEntity.ok()
        .header(HttpHeaders.SET_COOKIE, authCookie.clear().toString())
        .build();
  }

  @PostMapping("/resend-code")
  public ResponseEntity<Map<String, String>> resendCode(@Valid @RequestBody ResendCodeRequest req) {
    return ResponseEntity.ok(authService.resendCode(req.getEmail(), req.getMode()));
  }

  private String extractTokenFromCookie(HttpServletRequest request) {
    // Peut être null si la requête ne contient aucun cookie.
    Cookie[] cookies = request.getCookies();
    if (cookies == null) {
      return null;
    }
    // Recherche le cookie d'auth standard ; absent => logout idempotent côté service.
    for (Cookie cookie : cookies) {
      if (AuthCookie.NAME.equals(cookie.getName())) {
        return cookie.getValue();
      }
    }
    return null;
  }
}
