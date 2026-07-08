package com.moodit.execution_service;

import com.moodit.execution_service.security.GatewayAuthFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Même contrat d'auth que les autres services : le gateway a déjà validé le JWT et injecté
 * X-User-Email ; {@link GatewayAuthFilter} pose l'Authentication à partir de ce header. Exécuter
 * du code exige un utilisateur authentifié → {@code anyRequest().authenticated()}. Appel direct
 * sans gateway → pas de header → pas d'Authentication → 403 (fail-closed).
 */
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
                .addFilterBefore(gatewayAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/error").permitAll()
                        // Appels internes (core-service) : authentifiés par jeton dans le contrôleur,
                        // jamais exposés par le gateway.
                        .requestMatchers("/internal/**").permitAll()
                        .anyRequest().authenticated());
        return http.build();
    }
}
