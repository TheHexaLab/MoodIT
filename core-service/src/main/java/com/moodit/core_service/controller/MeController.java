// GET /api/me — profil de l'utilisateur connecté.
//
// L'identité provient du gateway : JwtAuthFilter valide le JWT puis injecte
// X-User-Email, que GatewayAuthFilter transforme en Authentication. On récupère
// donc l'email via le principal Spring Security (jamais un paramètre client).
//
// Routage : le gateway mappe /api/** → core-service (application.properties).

package com.moodit.core_service.controller;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

// NB : pas de @RequestMapping("/api") ici. Le préfixe /api est ajouté globalement
// par WebMvcConfig (addPathPrefix), donc /me est servi à /api/me. En remettre un ici
// donnerait /api/api/me.
@RestController
public class MeController {

  // Garde-fou de taille du blob de préférences : au-delà on refuse (protège la colonne
  // TEXT d'un payload aberrant). Les settings réels (thème + localisation) font < 1 Ko.
  private static final int MAX_SETTINGS_BYTES = 8 * 1024;

  private final MeRepository users;
  private final RealtimeEventPublisher realtimePublisher;
  private final ObjectMapper objectMapper;

  public MeController(
      MeRepository users, RealtimeEventPublisher realtimePublisher, ObjectMapper objectMapper) {
    this.users = users;
    this.realtimePublisher = realtimePublisher;
    this.objectMapper = objectMapper;
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

  // PUT /api/me/settings — l'utilisateur écrase son blob de préférences (thème, dernière
  // localisation dans l'app). Le corps est un JSON OPAQUE dont le front est propriétaire :
  // le backend le valide (JSON bien formé, taille bornée) et le persiste tel quel.
  //
  // Endpoint DÉDIÉ (pas d'extension de PATCH /me) : la localisation se sauvegarde à chaque
  // navigation, et on ne veut PAS déclencher le broadcast global `userUpdated` de PATCH /me
  // à cette fréquence. Les settings sont privés → aucune diffusion WebSocket ici.
  @PutMapping("/me/settings")
  public ResponseEntity<MeDto> updateSettings(
      Principal principal, @RequestBody(required = false) String settingsJson) {
    if (settingsJson == null || settingsJson.isBlank()) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Corps JSON requis");
    }
    if (settingsJson.getBytes(java.nio.charset.StandardCharsets.UTF_8).length
        > MAX_SETTINGS_BYTES) {
      throw new ResponseStatusException(
          HttpStatus.CONTENT_TOO_LARGE, "Préférences trop volumineuses");
    }
    // Normalise en re-sérialisant : garantit un JSON valide et compact en BD.
    String normalized;
    try {
      normalized = objectMapper.writeValueAsString(objectMapper.readTree(settingsJson));
    } catch (JsonProcessingException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "JSON invalide");
    }

    String email = principal.getName();
    MeDto updated =
        users
            .updateSettingsByEmail(email, normalized)
            .orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Utilisateur introuvable"));

    return ResponseEntity.ok(updated);
  }
}
