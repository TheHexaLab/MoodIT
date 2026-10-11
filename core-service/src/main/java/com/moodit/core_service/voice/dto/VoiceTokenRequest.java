// Corps de POST /voice/token : le salon (channel) que l'utilisateur veut rejoindre en vocal.
// L'identite ne vient JAMAIS du client : elle est prise du principal (X-User-Email injecte
// par le gateway), comme partout dans core-service.

package com.moodit.core_service.voice.dto;

import jakarta.validation.constraints.NotNull;

public record VoiceTokenRequest(@NotNull Long channelId) {}
