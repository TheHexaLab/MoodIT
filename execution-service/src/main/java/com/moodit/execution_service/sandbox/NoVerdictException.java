package com.moodit.execution_service.sandbox;

/**
 * Le conteneur runner a TOURNÉ mais n'a rendu aucun verdict exploitable : superviseur muet ou
 * illisible, mur atteint, sortie démesurée, notation déclarée incomplète. Distinct d'une sandbox
 * INDISPONIBLE (démon injoignable, image absente, service en arrêt) : ici, le code soumis a pu
 * jouer un rôle. Le 502 qui en résulte porte la cause {@code sans_verdict}, et core plafonne le
 * nombre de ces échecs par étudiant et par quiz (#116, S4) — au-delà, la tentative n'est plus
 * supprimée mais gardée « à revoir » par l'enseignant.
 */
public class NoVerdictException extends SandboxException {
    public NoVerdictException(String message) {
        super(message);
    }

    public NoVerdictException(String message, Throwable cause) {
        super(message, cause);
    }
}
