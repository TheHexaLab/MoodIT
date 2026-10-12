// Config du service vocal (prefixe moodit.voice.*). Record a binding par constructeur,
// enregistre par VoiceConfig (@EnableConfigurationProperties). Contrairement a core, PAS de
// flag `enabled` : ce service EST le vocal (son existence = feature active).

package com.moodit.voice_service.voice;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "moodit.voice")
public record VoiceProperties(Livekit livekit, long tokenTtlSeconds) {

  /** Coordonnees du SFU LiveKit. url = URL publique donnee au navigateur. */
  public record Livekit(String url, String apiKey, String apiSecret) {}
}
