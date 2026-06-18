// Enregistre les filtres servlet du Gateway. Seul JwtAuthFilter est actif.

package com.moodit.gateway.config;

import com.moodit.gateway.filter.JwtAuthFilter;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class GatewayConfig {

  // DÉSACTIVÉ : le rate limiting par IP gardait l'IP en mémoire, ce que la spécification
  // du projet interdit. Remplacé par un verrou de connexion par compte (auth-service).
  // @Bean
  // public FilterRegistrationBean<RateLimitFilter> rateLimitRegistration(RateLimitFilter filter) {
  //   FilterRegistrationBean<RateLimitFilter> registration = new FilterRegistrationBean<>();
  //   registration.setFilter(filter);
  //   registration.addUrlPatterns("/*");
  //   registration.setOrder(0);
  //   return registration;
  // }

  @Bean
  public FilterRegistrationBean<JwtAuthFilter> jwtFilter(JwtAuthFilter filter) {
    FilterRegistrationBean<JwtAuthFilter> registration = new FilterRegistrationBean<>();
    registration.setFilter(filter);
    registration.addUrlPatterns("/*");
    registration.setOrder(1);
    return registration;
  }
}
