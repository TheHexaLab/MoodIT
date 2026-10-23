package com.moodit.mcp_service.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * Filtre d'identité en aval du gateway : {@code X-User-Email} présent → Authentication posée ;
 * absent ou blanc → aucune Authentication (fail-closed). Dans tous les cas la chaîne continue.
 */
class GatewayAuthFilterTest {

    private final GatewayAuthFilter filter = new GatewayAuthFilter();

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    /** Exécute le filtre et capture l'Authentication visible par la suite de la chaîne. */
    private Authentication runWith(String email, AtomicReference<Boolean> chainCalled) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/mcp/courses/1/analyses");
        if (email != null) request.addHeader(GatewayAuthFilter.USER_EMAIL_HEADER, email);
        AtomicReference<Authentication> seen = new AtomicReference<>();
        filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> {
            chainCalled.set(true);
            seen.set(SecurityContextHolder.getContext().getAuthentication());
        });
        return seen.get();
    }

    @Test
    void enTetePresent_poseUneAuthenticationAuNomDeLEmail() throws Exception {
        AtomicReference<Boolean> chain = new AtomicReference<>(false);

        Authentication auth = runWith("prof@usherbrooke.ca", chain);

        assertThat(chain.get()).isTrue();
        assertThat(auth).isNotNull();
        assertThat(auth.getName()).isEqualTo("prof@usherbrooke.ca");
        assertThat(auth.isAuthenticated()).isTrue();
        assertThat(auth.getAuthorities()).isEmpty();
    }

    @Test
    void enTeteAbsent_aucuneAuthentication_maisLaChaineContinue() throws Exception {
        AtomicReference<Boolean> chain = new AtomicReference<>(false);

        assertThat(runWith(null, chain)).isNull();
        assertThat(chain.get()).isTrue();
    }

    @Test
    void enTeteBlanc_aucuneAuthentication() throws Exception {
        AtomicReference<Boolean> chain = new AtomicReference<>(false);

        assertThat(runWith("   ", chain)).isNull();
        assertThat(chain.get()).isTrue();
    }
}
