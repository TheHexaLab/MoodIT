package com.moodit.core_service.service;

import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Déclenche la correction ASYNCHRONE d'une tentative de quiz.
 *
 * <p>{@link TransactionalEventListener} en phase {@code AFTER_COMMIT} : la correction ne démarre
 * qu'une fois la tentative {@code "pending"} RÉELLEMENT committée (visible du job qui la relit).
 * Elle part ensuite sur l'un des deux executors de {@code AsyncConfig}, hors du thread de la
 * requête HTTP et hors de toute transaction : {@code quizCodeExecutor} si le quiz a des harnais de
 * code, {@code quizExecutor} sinon, pour qu'un quiz à choix ne patiente jamais derrière des
 * corrections compilées de plusieurs minutes. Bean SÉPARÉ de {@link QuizService} : la correction
 * passe par le proxy Spring.
 *
 * <p>Si l'executor refuse la tâche (file pleine), la tentative est abandonnée tout de suite
 * (supprimée, {@code quiz:attempt-failed} poussé) : sans cela elle resterait {@code "pending"} pour
 * toujours et l'index {@code uq_attempt_pending} bloquerait toute resoumission.
 *
 * <p>Les files des executors vivent en mémoire : un arrêt de core perd les corrections en attente
 * ou en cours. Au démarrage, les tentatives restées {@code "pending"} en BD sont donc remises en
 * correction, par le même aiguillage qu'une soumission.
 */
@Slf4j
@Component
public class QuizGradingListener {

  private final QuizService quizService;
  private final Executor quizExecutor;
  private final Executor quizCodeExecutor;

  public QuizGradingListener(
      QuizService quizService,
      @Qualifier("quizExecutor") Executor quizExecutor,
      @Qualifier("quizCodeExecutor") Executor quizCodeExecutor) {
    this.quizService = quizService;
    this.quizExecutor = quizExecutor;
    this.quizCodeExecutor = quizCodeExecutor;
  }

  @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
  public void onAttemptSubmitted(AttemptSubmittedEvent event) {
    dispatch(event);
  }

  /**
   * Reprend les corrections perdues par l'arrêt précédent de core. Une erreur de lecture est
   * journalisée sans empêcher le démarrage : les tentatives seront reprises au suivant.
   */
  @EventListener(ApplicationReadyEvent.class)
  public void resumePendingGradings() {
    List<AttemptSubmittedEvent> pending;
    try {
      pending = quizService.pendingGradings();
    } catch (RuntimeException e) {
      log.error("Reprise des corrections pending impossible au démarrage", e);
      return;
    }
    if (pending.isEmpty()) {
      return;
    }
    log.warn("{} tentative(s) pending reprise(s) au démarrage", pending.size());
    pending.forEach(this::dispatch);
  }

  private void dispatch(AttemptSubmittedEvent event) {
    Executor executor = event.needsSandbox() ? quizCodeExecutor : quizExecutor;
    try {
      executor.execute(() -> quizService.gradeAttempt(event.attemptId()));
    } catch (RejectedExecutionException e) {
      quizService.abandonGrading(event.attemptId(), e);
    }
  }
}
