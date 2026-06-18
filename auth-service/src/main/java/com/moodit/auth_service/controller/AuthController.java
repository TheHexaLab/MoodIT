package com.moodit.auth_service.controller;

import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.LoginRequest;
import com.moodit.auth_service.dto.RegisterRequest;
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
  public ResponseEntity<Boolean> validate(@RequestHeader("Authorization") String authHeader) {
    String token = authHeader.replace("Bearer ", "");
    return ResponseEntity.ok(authService.validate(token));
  }

  @PostMapping("/verify-email")
  public ResponseEntity<Map<String, String>> verifyEmail(@RequestBody Map<String, String> body) {
    return ResponseEntity.ok(authService.verifyEmail(body.get("email"), body.get("code")));
  }

  @PostMapping("/verify-2fa")
  public ResponseEntity<AuthResponse> verify2FA(@RequestBody Map<String, String> body) {
    return ResponseEntity.ok(authService.verify2FA(body.get("email"), body.get("code")));
  }

  @PostMapping("/resend-code")
  public ResponseEntity<Map<String, String>> resendCode(@RequestBody Map<String, String> body) {
    return ResponseEntity.ok(authService.resendCode(body.get("email"), body.get("mode")));
  }
}
