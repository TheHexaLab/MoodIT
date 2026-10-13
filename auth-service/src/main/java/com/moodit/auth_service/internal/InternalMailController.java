// Endpoint INTERNE (service à service) : core-service demande l'envoi de l'email « nouvel appareil
// pour le vocal chiffré ». NON routé par le gateway (seul /auth/** l'est) → inatteignable de
// l'extérieur ; authentifié en plus par le jeton partagé X-Internal-Token (= app.internal.token).

package com.moodit.auth_service.internal;

import com.moodit.auth_service.service.EmailService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/mail")
@RequiredArgsConstructor
public class InternalMailController {

  public record NewVoiceDeviceRequest(
      @NotBlank @Email String email, @Size(max = 64) String label, @NotBlank String createdAt) {}

  private final EmailService emailService;

  @Value("${app.internal.token:}")
  private String internalToken;

  /** 202 : l'envoi est asynchrone (EmailService @Async). */
  @PostMapping("/new-voice-device")
  public ResponseEntity<Void> newVoiceDevice(
      @RequestHeader(value = "X-Internal-Token", required = false) String token,
      @Valid @RequestBody NewVoiceDeviceRequest body) {
    if (unauthorized(token)) return ResponseEntity.status(403).build();
    emailService.sendNewVoiceDevice(body.email(), body.label(), body.createdAt());
    return ResponseEntity.accepted().build();
  }

  /** Jeton partagé requis dès qu'il est configuré ; comparaison en temps constant. */
  private boolean unauthorized(String token) {
    if (internalToken == null || internalToken.isBlank()) return false;
    if (token == null) return true;
    return !MessageDigest.isEqual(
        internalToken.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
  }
}
