package com.moodit.execution_service.security;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import static org.assertj.core.api.Assertions.assertThat;

/** Filtre d'identité : X-User-Email (posé par le gateway) → Authentication ; absent → aucune (fail-closed). */
class GatewayAuthFilterTest {

    private final GatewayAuthFilter filter = new GatewayAuthFilter();

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    private Authentication filterWith(String email) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/exec/run");
        if (email != null) req.addHeader(GatewayAuthFilter.USER_EMAIL_HEADER, email);
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(req, new MockHttpServletResponse(), chain);
        assertThat(chain.getRequest()).isSameAs(req);   // la chaîne continue toujours
        return SecurityContextHolder.getContext().getAuthentication();
    }

    @Test
    void en_tete_present_pose_une_authentication_au_nom_de_l_utilisateur() throws Exception {
        Authentication auth = filterWith("alice@usherbrooke.ca");

        assertThat(auth).isNotNull();
        assertThat(auth.getPrincipal()).isEqualTo("alice@usherbrooke.ca");
        assertThat(auth.isAuthenticated()).isTrue();
        assertThat(auth.getAuthorities()).isEmpty();
    }

    @Test
    void en_tete_absent_ou_vide_ne_pose_rien() throws Exception {
        assertThat(filterWith(null)).isNull();
        assertThat(filterWith("   ")).isNull();
    }
}
