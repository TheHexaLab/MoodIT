package com.moodit.core_service.repository;

/**
 * Tentatives d'un utilisateur sur un quiz, lues en UNE requête (un seul instantané en READ
 * COMMITTED) pour le contrôle préalable d'une soumission : nombre de tentatives, plus grand
 * {@code attempt_no} (0 sans tentative), et la tentative {@code "pending"} s'il y en a une (au
 * plus une, index partiel {@code uq_attempt_pending}) avec son marqueur de relance.
 *
 * <p>Lues en deux requêtes, ces valeurs pouvaient se contredire : un pending validé ou supprimé
 * entre les deux était compté sans être vu, ou vu sans être compté (cf.
 * {@link AttemptRepository#snapshotForSubmission}).
 *
 * <p>Types BOXÉS : ceux que Hibernate infère pour les agrégats de l'expression constructeur.
 */
public record AttemptSnapshot(Long count, Integer maxAttemptNo, Integer pendingAttemptId,
        Integer pendingRegrade) {

    /** Un pending existe-t-il ? */
    public boolean hasPending() {
        return pendingAttemptId != null;
    }

    /** Ce pending est-il une RELANCE de l'enseignant ? (jamais null : COALESCE dans la requête) */
    public boolean pendingIsRegrade() {
        return pendingRegrade > 0;
    }
}
