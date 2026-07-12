package com.moodit.core_service.service;

import lombok.RequiredArgsConstructor;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Déclenche la correction ASYNCHRONE d'une tentative de quiz.
 *
 * <p>{@link TransactionalEventListener} en phase {@code AFTER_COMMIT} : la correction ne démarre
 * qu'une fois la tentative {@code "pending"} RÉELLEMENT committée (visible du job qui la relit).
 * {@link Async} sur l'executor {@code quizExecutor} : le sandbox (lent) tourne hors du thread de la
 * requête HTTP et hors de toute transaction. Bean SÉPARÉ de {@link QuizService} pour que l'appel
 * {@code @Async} passe par le proxy Spring (une self-invocation resterait synchrone).
 */
@Component
@RequiredArgsConstructor
public class QuizGradingListener {

  private final QuizService quizService;

  @Async("quizExecutor")
  @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
  public void onAttemptSubmitted(AttemptSubmittedEvent event) {
    quizService.gradeAttempt(event.attemptId());
  }
}
