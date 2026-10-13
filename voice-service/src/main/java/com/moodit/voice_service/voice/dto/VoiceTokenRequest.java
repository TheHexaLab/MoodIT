// Corps de POST /api/voice/token : le salon (channel) que l'utilisateur veut rejoindre en
// vocal. L'identite ne vient JAMAIS du client : elle est prise du header X-User-Email injecte
// par le gateway. deviceId : appareil (profil de navigateur) enregistre dans l'annuaire de cles
// du vocal chiffre ; voice-service verifie aupres de core qu'il est bien a cet utilisateur.

package com.moodit.voice_service.voice.dto;

import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public record VoiceTokenRequest(@NotNull Long channelId, @NotNull UUID deviceId) {}
