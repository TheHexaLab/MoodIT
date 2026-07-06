package com.moodit.mcp_service;

import com.moodit.mcp_service.security.GatewayAuthFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Même contrat d'auth que core-service : le gateway a déjà validé le JWT (signature +
 * token actif) et injecté X-User-Email ; {@link GatewayAuthFilter} pose l'Authentication
 * à partir de ce header. L'autorisation fine (rôle « Administrateur ») est faite dans le
 * service (403 sinon). Appel direct sans gateway → pas de header → fail-closed.
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
                        // Page d'erreur accessible (sinon un 404 est redispatché en 403 trompeur).
                        .requestMatchers("/error").permitAll()
                        .anyRequest().permitAll());
        return http.build();
    }
}
