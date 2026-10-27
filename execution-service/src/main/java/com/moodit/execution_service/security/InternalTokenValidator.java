package com.moodit.execution_service.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Contrôle du jeton partagé {@code X-Internal-Token} des endpoints INTERNES (service à service,
 * jamais routés par le gateway). Utilisé par {@code InternalExecutionController}.
 *
 * <p>Fail-closed : un jeton configuré vide refuse TOUT, au lieu de désactiver le contrôle. La
 * propriété {@code app.internal.token} n'a de valeur de repli dans aucun profil (#31) : si
 * {@code INTERNAL_TOKEN} manque, le démarrage échoue. Comparaison en temps CONSTANT
 * ({@link MessageDigest#isEqual}) pour ne pas laisser deviner le jeton au temps de réponse.
 */
@Component
public class InternalTokenValidator {

    private final byte[] expected;

    public InternalTokenValidator(@Value("${app.internal.token}") String internalToken) {
        this.expected =
                internalToken == null ? new byte[0] : internalToken.getBytes(StandardCharsets.UTF_8);
    }

    /** Vrai si {@code token} est le jeton configuré ; toujours faux si aucun jeton n'est configuré. */
    public boolean isValid(String token) {
        if (expected.length == 0 || token == null) return false;
        return MessageDigest.isEqual(expected, token.getBytes(StandardCharsets.UTF_8));
    }
}
