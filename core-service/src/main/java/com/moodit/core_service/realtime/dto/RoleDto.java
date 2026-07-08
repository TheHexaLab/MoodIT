// Rôle poussé en temps réel (scope = utilisateur). Utilisé pour diffuser la liste des rôles
// GLOBAUX (User_Role) à jour quand ils changent, afin que le client re-dérive ses droits
// (admin général / superadministrateur) LIVE.

package com.moodit.core_service.realtime.dto;

public record RoleDto(Integer id, String name) {}
