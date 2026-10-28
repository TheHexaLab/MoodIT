package com.moodit.execution_service.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Contrôle du jeton partagé {@code X-Internal-Token} des endpoints INTERNES (service à service,
 * jamais routés par le gateway). Utilisé par {@code InternalExecutionController}.
 *
 * <p>La propriété {@code app.internal.token} n'a de valeur de repli dans aucun profil (#31) : si
 * {@code INTERNAL_TOKEN} manque, OU s'il est défini mais vide, le démarrage échoue (un jeton vide
 * refuserait tous les appels internes sans rien signaler). Comparaison en temps CONSTANT
 * ({@link MessageDigest#isEqual}) pour ne pas laisser deviner le jeton au temps de réponse.
 */
@Component
public class InternalTokenValidator {

    private final byte[] expected;

    public InternalTokenValidator(@Value("${app.internal.token}") String internalToken) {
        if (internalToken == null || internalToken.isBlank()) {
            throw new IllegalStateException("INTERNAL_TOKEN est vide : définir un jeton interne");
        }
        this.expected = internalToken.getBytes(StandardCharsets.UTF_8);
    }

    /** Vrai si {@code token} est le jeton configuré. */
    public boolean isValid(String token) {
        if (token == null) return false;
        return MessageDigest.isEqual(expected, token.getBytes(StandardCharsets.UTF_8));
    }
}
