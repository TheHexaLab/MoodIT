// Active le binding de VoiceProperties et expose la fabrique de JoinToken.

package com.moodit.voice_service.voice;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(VoiceProperties.class)
public class VoiceConfig {

  @Bean
  LiveKitTokenFactory liveKitTokenFactory(VoiceProperties props) {
    return new LiveKitTokenFactory(props);
  }
}
