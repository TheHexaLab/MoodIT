// GET /api/me — profil de l'utilisateur connecté.
//
// L'identité provient du gateway : JwtAuthFilter valide le JWT puis injecte
// X-User-Email, que GatewayAuthFilter transforme en Authentication. On récupère
// donc l'email via le principal Spring Security (jamais un paramètre client).
//
// Routage : le gateway mappe /api/** → core-service (application.properties).

package com.moodit.core_service.user;

import jakarta.validation.Valid;
import java.security.Principal;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@RestController
@RequestMapping("/api")
public class MeController {

  private final UserRepository users;

  public MeController(UserRepository users) {
    this.users = users;
  }

  @GetMapping("/me")
  public ResponseEntity<MeDto> me(Principal principal) {
    String email = principal.getName();
    MeDto me =
        users
            .findByEmail(email)
            .orElseThrow(
                // Token valide mais aucun compte correspondant en BD : cas anormal
                // (compte supprimé alors que le token est encore actif).
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Utilisateur introuvable"));
    return ResponseEntity.ok(me);
  }

  // PATCH /api/me — l'utilisateur modifie son propre profil (prénom, nom, couleur).
  // username/email/rôles ne sont pas modifiables ici. Photo (multipart) : non gérée.
  @PatchMapping("/me")
  public ResponseEntity<MeDto> updateMe(
      Principal principal, @Valid @RequestBody UpdateMeRequest body) {
    String email = principal.getName();
    MeDto updated =
        users
            .updateByEmail(email, body.firstName(), body.lastName(), body.avatarColor())
            .orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Utilisateur introuvable"));
    return ResponseEntity.ok(updated);
  }
}
