package com.moodit.core_service.service;

/**
 * Évènement applicatif publié une fois une tentative de quiz PERSISTÉE en statut {@code "pending"}.
 * Un listener transactionnel {@code @AfterCommit} déclenche alors sa correction hors de la requête
 * HTTP (cf. {@link QuizGradingListener}). {@code needsSandbox} indique qu'au moins une question a
 * des harnais à exécuter : la correction passe alors par le pool dédié au code.
 */
public record AttemptSubmittedEvent(Integer attemptId, boolean needsSandbox) {}
