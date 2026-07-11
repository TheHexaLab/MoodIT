package com.moodit.core_service.exception;

/**
 * Levée quand une question Code d'un quiz ne peut PAS être vérifiée à la soumission (service
 * d'exécution injoignable / en échec). La tentative n'est alors PAS enregistrée : l'étudiant
 * peut renvoyer sans consommer sa tentative unique. Mappée en 503 (service indisponible).
 */
public class CodeVerificationUnavailableException extends RuntimeException {
    public CodeVerificationUnavailableException() {
        super("Code verification unavailable");
    }
}
