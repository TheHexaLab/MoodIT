package com.moodit.core_service.exception;

/**
 * Levée quand la correction d'une tentative est INTERROMPUE par l'arrêt de core (fil de correction
 * interrompu pendant l'attente d'execution-service). Ce n'est pas une défaillance de la
 * correction : la tentative reste {@code "pending"} et sera reprise au démarrage suivant
 * (cf. QuizGradingListener#resumePendingGradings), au lieu d'être supprimée.
 */
public class GradingInterruptedException extends RuntimeException {
    public GradingInterruptedException() {
        super("Grading interrupted by shutdown");
    }
}
