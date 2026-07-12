// GET /api/me — profil de l'utilisateur connecté.
//
// L'identité provient du gateway : JwtAuthFilter valide le JWT puis injecte
// X-User-Email, que GatewayAuthFilter transforme en Authentication. On récupère
// donc l'email via le principal Spring Security (jamais un paramètre client).
//
// Routage : le gateway mappe /api/** → core-service (application.properties).

package com.moodit.core_service.controller;

import com.moodit.core_service.dto.MeDto;
import com.moodit.core_service.dto.UpdateMeRequest;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.Author;
import com.moodit.core_service.repository.MeRepository;
import jakarta.validation.Valid;
import java.security.Principal;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

// NB : pas de @RequestMapping("/api") ici. Le préfixe /api est ajouté globalement
// par WebMvcConfig (addPathPrefix), donc /me est servi à /api/me. En remettre un ici
// donnerait /api/api/me.
@RestController
public class MeController {

  private final MeRepository users;
  private final RealtimeEventPublisher realtimePublisher;

  public MeController(MeRepository users, RealtimeEventPublisher realtimePublisher) {
    this.users = users;
    this.realtimePublisher = realtimePublisher;
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

    // Diffusion GLOBALE : chaque client met à jour l'auteur (prénom/nom/couleur) des
    // messages et posts de cet utilisateur déjà chargés (le profil peut apparaître partout).
    realtimePublisher.userUpdated(
        new Author(
            updated.id(),
            updated.username(),
            updated.firstName(),
            updated.lastName(),
            updated.avatarColor()));

    return ResponseEntity.ok(updated);
  }
}
