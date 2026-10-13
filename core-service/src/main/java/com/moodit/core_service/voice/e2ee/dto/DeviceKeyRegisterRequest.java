// Corps de POST /api/keys/devices : un navigateur enregistre SES clés publiques. Le propriétaire
// n'est JAMAIS dans le corps : c'est l'utilisateur du token (X-User-Email posé par le gateway).

package com.moodit.core_service.voice.e2ee.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.UUID;

public record DeviceKeyRegisterRequest(
    @NotNull UUID deviceId,
    @Size(max = 64) String label,
    @NotBlank @Size(max = 512) String signPub,
    @NotBlank @Size(max = 512) String dhPub,
    @NotBlank @Size(max = 512) String dhSig) {}
