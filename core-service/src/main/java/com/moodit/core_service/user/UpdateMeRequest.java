// Corps de PATCH /api/me : champs modifiables du profil par l'utilisateur lui-même.
// Volontairement restreint — on ne laisse PAS modifier username/email/rôles ici.
// La photo (multipart) n'est pas gérée : pas d'infra de stockage de fichiers (TODO).

package com.moodit.core_service.user;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record UpdateMeRequest(
    @NotBlank @Size(max = 128) String firstName,
    @NotBlank @Size(max = 128) String lastName,
    // Couleur hex #RRGGBB ou #RRGGBBAA (colonne avatar_color VARCHAR(9)).
    @NotBlank @Pattern(regexp = "^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$") String avatarColor) {}
