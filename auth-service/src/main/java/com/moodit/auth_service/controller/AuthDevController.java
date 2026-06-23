package com.moodit.auth_service.controller;

import com.moodit.auth_service.service.AuthService;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

// Endpoints réservés au développement : ce bean n'est chargé que sous le profil "dev",
// donc /auth/verify/{username} n'existe pas en production.
@Profile("dev")
@RestController
@RequestMapping("/auth")
@RequiredArgsConstructor
public class AuthDevController {

  private final AuthService authService;

  @GetMapping("/verify/{username}")
  public ResponseEntity<Map<String, String>> verifyDev(@PathVariable String username) {
    return ResponseEntity.ok(authService.verifyDev(username));
  }
}
