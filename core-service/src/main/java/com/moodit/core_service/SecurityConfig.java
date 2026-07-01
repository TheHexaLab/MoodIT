package com.moodit.core_service;

import com.moodit.core_service.security.GatewayAuthFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

  private final GatewayAuthFilter gatewayAuthFilter;

  public SecurityConfig(GatewayAuthFilter gatewayAuthFilter) {
    this.gatewayAuthFilter = gatewayAuthFilter;
  }

  @Bean
  public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
    http.csrf(AbstractHttpConfigurer::disable)
        // Pose l'Authentication à partir de X-User-Email (injecté par le gateway)
        // avant l'évaluation des règles d'autorisation ci-dessous.
        .addFilterBefore(gatewayAuthFilter, UsernamePasswordAuthenticationFilter.class)
        .authorizeHttpRequests(
            auth ->
                auth
                    // Le handshake WebSocket s'authentifie lui-même (JWT en query
                    // param, validé par JwtHandshakeInterceptor) : laissé passer ici.
                    .requestMatchers("/ws/**")
                    .permitAll()
                    // Outils de DEV : le contrôleur n'existe que sous le profil `dev`
                    // (@Profile), donc hors dev ces chemins ne mappent rien (404).
                    .requestMatchers("/dev/**")
                    .permitAll()
                    // La page d'erreur doit rester accessible : sinon un 404 (handler
                    // absent) est redispatché vers /error puis bloqué → devient un 403
                    // trompeur. La laisser passer rend les vrais codes (404/405) visibles.
                    .requestMatchers("/error")
                    .permitAll()
                    .anyRequest().permitAll()
                    );
    return http.build();
  }
}