// Config de la feature vocale (prefixe moodit.voice.*). Record a binding par constructeur ;
// enregistre par VoiceConfig (@EnableConfigurationProperties), lui-meme conditionne par le
// flag. Donc hors activation, aucun de ces placeholders n'est resolu (pas de fail-fast
// intempestif en prod quand le vocal est OFF).

package com.moodit.core_service.voice;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "moodit.voice")
public record VoiceProperties(boolean enabled, Livekit livekit, long tokenTtlSeconds) {

  /** Coordonnees du SFU LiveKit. url = URL publique donnee au navigateur. */
  public record Livekit(String url, String apiKey, String apiSecret) {}
}
