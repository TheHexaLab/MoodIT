// Verification du jeton partage X-Internal-Token des endpoints /internal/** (appels service a
// service, NON routes par le gateway). Comparaison a temps constant.

package com.moodit.voice_service.internal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class InternalToken {

  private final String expected;

  public InternalToken(@Value("${app.internal.token:}") String expected) {
    this.expected = expected;
  }

  /** true si l'appel doit etre refuse. Jeton non configure : controle desactive (dev). */
  public boolean rejects(String token) {
    if (expected == null || expected.isBlank()) {
      return false;
    }
    if (token == null) {
      return true;
    }
    return !MessageDigest.isEqual(
        expected.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
  }
}
