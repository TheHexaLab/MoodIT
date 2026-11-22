package com.moodit.core_service.exception;

/**
 * La correction a TOURNÉ mais n'a rendu aucun verdict : execution-service a répondu 502 de cause
 * {@code sans_verdict} (conteneur runner mort, superviseur muet, mur atteint). Contrairement à une
 * sandbox simplement indisponible, le code soumis a pu y jouer un rôle : ces échecs sont comptés
 * par étudiant et par quiz, et au-delà du plafond la tentative est gardée « à revoir » au lieu
 * d'être supprimée (#116, S4).
 */
public class CodeVerificationNoVerdictException extends CodeVerificationUnavailableException {
}
