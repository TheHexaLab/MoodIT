// Profil de l'utilisateur connecté renvoyé par GET /api/me. Calqué sur le type
// `User` du domaine frontend (frontend/src/types/domain.ts) : id, username,
// firstName, lastName, avatarColor, email, roles. On n'expose AUCUN champ sensible
// (password_hash, tokens, codes de vérification…).
//
// `roles` = rôles GLOBAUX (User_Role). Le front en dérive `isAdmin` (rôle
// « Administrateur »). Les rôles par programme (User_Program_Role) ne sont pas ici.
//
// `settings` = blob JSON OPAQUE (colonne TEXT) appartenant au front : préférences
// utilisateur (thème, dernière localisation dans l'app). Le backend ne fait que le
// persister tel quel (cf. PUT /api/me/settings) ; `null` pour un compte neuf.

package com.moodit.core_service.dto;

import java.util.List;

public record MeDto(
    long id,
    String username,
    String firstName,
    String lastName,
    String email,
    String avatarColor,
    List<Role> roles,
    String settings) {}
