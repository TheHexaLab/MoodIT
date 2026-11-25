package com.moodit.core_service.exception;

/**
 * Levée quand une question Code d'un quiz ne peut PAS être évaluée pendant sa correction
 * asynchrone (service d'exécution injoignable, en échec, réponse incohérente). La tentative pending
 * est alors supprimée (l'étudiant renvoie sans consommer sa tentative unique) ou gardée « à revoir »
 * (cf. QuizService, gestion des échecs de correction). La correction tourne hors de toute requête
 * HTTP : le mappage en 503 de GlobalExceptionHandler n'est qu'un filet.
 */
public class CodeVerificationUnavailableException extends RuntimeException {
    public CodeVerificationUnavailableException() {
        super("Code verification unavailable");
    }
}
