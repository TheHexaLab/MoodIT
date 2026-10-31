// Enregistre les filtres servlet du Gateway : OriginCheckFilter (origine des écritures, #234),
// puis JwtAuthFilter.
//
// Note : le rate limiting par IP a été retiré volontairement — la spécification du projet
// interdit de conserver l'IP en mémoire. Il est remplacé par un verrou de connexion PAR
// COMPTE dans l'auth-service (AuthService.login).

package com.moodit.gateway.config;

import com.moodit.gateway.filter.JwtAuthFilter;
import com.moodit.gateway.filter.OriginCheckFilter;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class GatewayConfig {

  // Avant le JWT : une écriture d'une origine refusée n'atteint ni auth-service ni les services.
  @Bean
  public FilterRegistrationBean<OriginCheckFilter> originFilter(OriginCheckFilter filter) {
    FilterRegistrationBean<OriginCheckFilter> registration = new FilterRegistrationBean<>();
    registration.setFilter(filter);
    registration.addUrlPatterns("/*");
    registration.setOrder(0);
    return registration;
  }

  @Bean
  public FilterRegistrationBean<JwtAuthFilter> jwtFilter(JwtAuthFilter filter) {
    FilterRegistrationBean<JwtAuthFilter> registration = new FilterRegistrationBean<>();
    registration.setFilter(filter);
    registration.addUrlPatterns("/*");
    registration.setOrder(1);
    return registration;
  }
}
