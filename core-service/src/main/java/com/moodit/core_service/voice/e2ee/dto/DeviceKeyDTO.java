// Clés publiques d'un appareil, telles que lues par les AUTRES participants (échange de clés) ou
// par son propriétaire (« Mes appareils »). Pas d'email : userId + username suffisent.

package com.moodit.core_service.voice.e2ee.dto;

import java.time.LocalDateTime;
import java.util.UUID;

public record DeviceKeyDTO(
    UUID deviceId,
    int userId,
    String username,
    String label,
    String signPub,
    String dhPub,
    String dhSig,
    LocalDateTime createdAt,
    LocalDateTime revokedAt) {}
