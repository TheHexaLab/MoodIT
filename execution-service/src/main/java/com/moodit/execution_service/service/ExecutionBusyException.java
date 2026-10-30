package com.moodit.execution_service.service;

/** Exécution refusée faute de place (sandbox saturé ou trop de requêtes du même utilisateur). */
public class ExecutionBusyException extends RuntimeException {

    /** Toutes les places du sandbox sont prises et aucune ne s'est libérée à temps. */
    public static final String SANDBOX_BUSY =
            "Le service d'exécution est très sollicité. Réessaie dans quelques secondes.";

    /** L'utilisateur a déjà le nombre maximal d'exécutions en cours. */
    public static final String USER_BUSY =
            "Tu as déjà des exécutions en cours. Attends qu'elles se terminent, puis réessaie.";

    public ExecutionBusyException(String message) {
        super(message);
    }
}
