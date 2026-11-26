package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.same;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.task.TaskRejectedException;

/**
 * Aiguillage de la correction (#116) : un quiz avec harnais part sur le pool du code, un quiz sans
 * harnais sur le pool rapide, et une tâche refusée abandonne la tentative au lieu de la laisser
 * pending pour toujours.
 */
class QuizGradingListenerTest {

  private QuizService quizService;
  private Executor quickExecutor;
  private Executor codeExecutor;
  private QuizGradingListener listener;

  @BeforeEach
  void setUp() {
    quizService = mock(QuizService.class);
    quickExecutor = mock(Executor.class);
    codeExecutor = mock(Executor.class);
    // Exécution immédiate : on vérifie que la tâche soumise corrige bien la tentative visée.
    doAnswer(inv -> {
          inv.<Runnable>getArgument(0).run();
          return null;
        })
        .when(quickExecutor)
        .execute(any());
    doAnswer(inv -> {
          inv.<Runnable>getArgument(0).run();
          return null;
        })
        .when(codeExecutor)
        .execute(any());
    listener = new QuizGradingListener(quizService, quickExecutor, codeExecutor);
  }

  @Test
  void quizWithHarness_gradedOnCodePool() {
    listener.onAttemptSubmitted(new AttemptSubmittedEvent(7, true));

    verify(codeExecutor).execute(any());
    verifyNoInteractions(quickExecutor);
    verify(quizService).gradeAttempt(7);
  }

  @Test
  void quizWithoutHarness_gradedOnFastPool() {
    listener.onAttemptSubmitted(new AttemptSubmittedEvent(8, false));

    verify(quickExecutor).execute(any());
    verifyNoInteractions(codeExecutor);
    verify(quizService).gradeAttempt(8);
  }

  @Test
  void taskRejected_abandonsAttempt() {
    TaskRejectedException rejected = new TaskRejectedException("file pleine");
    doThrow(rejected).when(codeExecutor).execute(any());

    listener.onAttemptSubmitted(new AttemptSubmittedEvent(9, true));

    verify(quizService).abandonGrading(org.mockito.ArgumentMatchers.eq(9), same(rejected));
    verify(quizService, never()).gradeAttempt(any());
  }

  @Test
  void startup_resumesEachPendingOnItsPool() {
    // Chaque executor note les tentatives corrigées PENDANT qu'il exécute la tâche : on vérifie
    // ainsi quelle tentative part sur quel pool, pas seulement que chacun a servi une fois.
    List<Integer> onCodePool = new ArrayList<>();
    List<Integer> onQuickPool = new ArrayList<>();
    AtomicReference<List<Integer>> runningOn = new AtomicReference<>();
    recordOn(codeExecutor, onCodePool, runningOn);
    recordOn(quickExecutor, onQuickPool, runningOn);
    doAnswer(inv -> runningOn.get().add(inv.getArgument(0)))
        .when(quizService)
        .gradeAttempt(any());
    when(quizService.pendingGradings())
        .thenReturn(List.of(new AttemptSubmittedEvent(11, true), new AttemptSubmittedEvent(12, false)));

    listener.resumePendingGradings();

    assertThat(onCodePool).containsExactly(11);
    assertThat(onQuickPool).containsExactly(12);
  }

  /** Fait exécuter immédiatement les tâches de {@code executor} en les rattachant à {@code ids}. */
  private static void recordOn(
      Executor executor, List<Integer> ids, AtomicReference<List<Integer>> runningOn) {
    doAnswer(inv -> {
          runningOn.set(ids);
          try {
            inv.<Runnable>getArgument(0).run();
          } finally {
            runningOn.set(null);
          }
          return null;
        })
        .when(executor)
        .execute(any());
  }

  @Test
  void startup_resumeRejected_abandonsAttempt() {
    TaskRejectedException rejected = new TaskRejectedException("file pleine");
    doThrow(rejected).when(codeExecutor).execute(any());
    when(quizService.pendingGradings()).thenReturn(List.of(new AttemptSubmittedEvent(13, true)));

    listener.resumePendingGradings();

    verify(quizService).abandonGrading(org.mockito.ArgumentMatchers.eq(13), same(rejected));
  }

  @Test
  void startup_noPending_nothingScheduled() {
    when(quizService.pendingGradings()).thenReturn(List.of());

    listener.resumePendingGradings();

    verifyNoInteractions(quickExecutor, codeExecutor);
  }

  @Test
  void startup_readFailure_doesNotBlockStartup() {
    when(quizService.pendingGradings()).thenThrow(new IllegalStateException("BD indisponible"));

    listener.resumePendingGradings();

    verifyNoInteractions(quickExecutor, codeExecutor);
  }
}
