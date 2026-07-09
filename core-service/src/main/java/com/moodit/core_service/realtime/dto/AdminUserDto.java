// Administrateur (porteur d'un rôle global) poussé en temps réel dans l'évènement
// `adminRoles:changed`. Projection LÉGÈRE de UserDTO : uniquement les champs affichés par le popup
// des administrateurs (frontend/src/services/appSocket.ts → GlobalRoleUser). On EXCLUT volontairement
// `createdAt` (LocalDateTime) et `settings` : inutiles au front, et `createdAt` ferait échouer la
// sérialisation de l'ObjectMapper temps réel (pas de module JSR310).

package com.moodit.core_service.realtime.dto;

import java.util.List;

public record AdminUserDto(
    Integer id,
    String username,
    String firstName,
    String lastName,
    String email,
    String avatarColor,
    List<Integer> roles) {}
