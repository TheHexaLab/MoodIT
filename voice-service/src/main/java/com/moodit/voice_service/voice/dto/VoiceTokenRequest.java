// Corps de POST /api/voice/token : le salon (channel) que l'utilisateur veut rejoindre en
// vocal. L'identite ne vient JAMAIS du client : elle est prise du header X-User-Email injecte
// par le gateway.

package com.moodit.voice_service.voice.dto;

import jakarta.validation.constraints.NotNull;

public record VoiceTokenRequest(@NotNull Long channelId) {}
