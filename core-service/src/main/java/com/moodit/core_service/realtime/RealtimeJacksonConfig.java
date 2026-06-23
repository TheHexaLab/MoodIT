// Spring Boot 4 / Spring 7 auto-configurent un ObjectMapper Jackson 3 (package
// `tools.jackson`), alors que nos DTO temps réel sont annotés avec Jackson 2
// (`com.fasterxml.jackson.annotation`) et sérialisés via un ObjectMapper Jackson 2.
// On fournit donc explicitement ce mapper Jackson 2 pour la couche WebSocket
// (RealtimeEventPublisher + RealtimeWebSocketHandler).
//
// Pas de conflit avec le bean auto-configuré : c'est un TYPE différent
// (com.fasterxml.jackson.databind.ObjectMapper vs tools.jackson.databind.ObjectMapper).

package com.moodit.core_service.realtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RealtimeJacksonConfig {

  @Bean
  @ConditionalOnMissingBean(ObjectMapper.class)
  public ObjectMapper realtimeObjectMapper() {
    return new ObjectMapper();
  }
}
