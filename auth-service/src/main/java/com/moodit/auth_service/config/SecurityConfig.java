// Spring Security de l'auth-service : routes publiques en permitAll, reste authentifié, encodeur BCrypt.

package com.moodit.auth_service.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

  @Bean
  public PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder();
  }

  @Bean
  public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http.csrf(csrf -> csrf.disable())
        .sessionManagement(
            session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(
            auth ->
                auth.requestMatchers(
                        "/auth/register",
                        "/auth/login",
                        "/auth/validate",
                        "/auth/verify/**",
                        "/auth/verify-email",
                        "/auth/verify-2fa",
                        "/auth/resend-code",
                        "/swagger-ui/**",
                        "/swagger-ui/index.html",
                        "/swagger-ui.html",
                        "/v3/api-docs/**",
                        "/webjars/**")
                    .permitAll()
                    .anyRequest()
                    .authenticated());

    return http.build();
  }
}
