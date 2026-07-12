package com.moodit.core_service.service;

/**
 * Évènement applicatif publié une fois une tentative de quiz PERSISTÉE en statut {@code "pending"}.
 * Un listener transactionnel {@code @AfterCommit} + {@code @Async} déclenche alors la correction du
 * code hors de la requête HTTP (cf. {@link QuizGradingListener}).
 */
public record AttemptSubmittedEvent(Integer attemptId) {}
