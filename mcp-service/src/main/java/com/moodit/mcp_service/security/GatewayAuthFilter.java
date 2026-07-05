// Authentifie les requêtes REST en aval du gateway. Le gateway valide le JWT
// (signature + token actif) puis injecte X-User-Email — et neutralise toute valeur
// envoyée par le client. On fait donc confiance à ce header : présent → on pose une
// Authentication dans le SecurityContext ; absent (appel direct sans gateway) → aucune
// Authentication → fail-closed. Copie du filtre homonyme de core-service.

package com.moodit.mcp_service.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class GatewayAuthFilter extends OncePerRequestFilter {

    /** Header d'identité injecté par le gateway après validation forte du JWT. */
    public static final String USER_EMAIL_HEADER = "X-User-Email";

    @Override
    protected void doFilterInternal(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull FilterChain filterChain)
            throws ServletException, IOException {

        String email = request.getHeader(USER_EMAIL_HEADER);
        if (email != null && !email.isBlank()) {
            var authentication = new UsernamePasswordAuthenticationToken(email, null, List.of());
            SecurityContextHolder.getContext().setAuthentication(authentication);
        }
        filterChain.doFilter(request, response);
    }
}
