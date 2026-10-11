// Point d'entree de la feature vocale. @ConditionalOnProperty : si moodit.voice.enabled
// n'est pas "true", AUCUN bean de ce paquet n'existe (ni config, ni fabrique de token, ni
// controleur grace a leur propre @ConditionalOnProperty) => endpoint /voice/** absent (404).
// C'est ce qui rend la feature retirable par un simple flag.

package com.moodit.core_service.voice;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@ConditionalOnProperty(prefix = "moodit.voice", name = "enabled", havingValue = "true")
@EnableConfigurationProperties(VoiceProperties.class)
public class VoiceConfig {

  @Bean
  LiveKitTokenFactory liveKitTokenFactory(VoiceProperties props) {
    return new LiveKitTokenFactory(props);
  }
}
