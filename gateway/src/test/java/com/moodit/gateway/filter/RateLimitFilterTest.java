package com.moodit.gateway.filter;

// DÉSACTIVÉ : le RateLimitFilter (rate limiting par IP) est désactivé — la spécification
// du projet interdit de conserver l'IP en mémoire. Voir GatewayConfig. La protection est
// désormais un verrou de connexion PAR COMPTE dans auth-service (AuthService.login).
// Tests conservés en commentaire pour référence.
/*
import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.ServletException;
import java.io.IOException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class RateLimitFilterTest {

  private RateLimitFilter filter;

  @BeforeEach
  void setUp() {
    // Instance neuve à chaque test => cache de buckets vierge (pas de fuite entre tests).
    filter = new RateLimitFilter();
  }

  private MockHttpServletResponse hit(String uri, String ip) throws ServletException, IOException {
    MockHttpServletRequest req = new MockHttpServletRequest("POST", uri);
    req.setRemoteAddr(ip);
    MockHttpServletResponse res = new MockHttpServletResponse();
    filter.doFilter(req, res, new MockFilterChain());
    return res;
  }

  @Test
  void nonLimitedRoute_alwaysPasses() throws Exception {
    for (int i = 0; i < 20; i++) {
      assertThat(hit("/api/courses", "1.1.1.1").getStatus()).isEqualTo(200);
    }
  }

  @Test
  void registerRoute_blocksAfterFive() throws Exception {
    for (int i = 0; i < 5; i++) {
      assertThat(hit("/auth/register", "2.2.2.2").getStatus()).isEqualTo(200);
    }
    assertThat(hit("/auth/register", "2.2.2.2").getStatus()).isEqualTo(429);
  }

  @Test
  void loginRoute_blocksAfterTen() throws Exception {
    for (int i = 0; i < 10; i++) {
      assertThat(hit("/auth/login", "3.3.3.3").getStatus()).isEqualTo(200);
    }
    assertThat(hit("/auth/login", "3.3.3.3").getStatus()).isEqualTo(429);
  }

  @Test
  void resendCodeRoute_isRateLimited() throws Exception {
    for (int i = 0; i < 5; i++) {
      assertThat(hit("/auth/resend-code", "4.4.4.4").getStatus()).isEqualTo(200);
    }
    assertThat(hit("/auth/resend-code", "4.4.4.4").getStatus()).isEqualTo(429);
  }

  @Test
  void differentIps_countedSeparately() throws Exception {
    for (int i = 0; i < 5; i++) {
      hit("/auth/register", "5.5.5.5");
    }
    // IP A épuisée...
    assertThat(hit("/auth/register", "5.5.5.5").getStatus()).isEqualTo(429);
    // ...mais IP B a son propre quota.
    assertThat(hit("/auth/register", "6.6.6.6").getStatus()).isEqualTo(200);
  }

  @Test
  void blockedResponse_hasRetryAfterHeader() throws Exception {
    for (int i = 0; i < 5; i++) {
      hit("/auth/register", "7.7.7.7");
    }
    MockHttpServletResponse blocked = hit("/auth/register", "7.7.7.7");
    assertThat(blocked.getStatus()).isEqualTo(429);
    assertThat(blocked.getHeader("Retry-After")).isEqualTo("60");
  }
}
*/
