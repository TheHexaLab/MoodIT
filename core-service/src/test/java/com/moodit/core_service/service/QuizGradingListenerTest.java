package com.moodit.core_service.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.same;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import java.util.concurrent.Executor;
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
  void quizAvecHarnais_corrigeSurLePoolDuCode() {
    listener.onAttemptSubmitted(new AttemptSubmittedEvent(7, true));

    verify(codeExecutor).execute(any());
    verifyNoInteractions(quickExecutor);
    verify(quizService).gradeAttempt(7);
  }

  @Test
  void quizSansHarnais_corrigeSurLePoolRapide() {
    listener.onAttemptSubmitted(new AttemptSubmittedEvent(8, false));

    verify(quickExecutor).execute(any());
    verifyNoInteractions(codeExecutor);
    verify(quizService).gradeAttempt(8);
  }

  @Test
  void tacheRefusee_abandonneLaTentative() {
    TaskRejectedException rejected = new TaskRejectedException("file pleine");
    doThrow(rejected).when(codeExecutor).execute(any());

    listener.onAttemptSubmitted(new AttemptSubmittedEvent(9, true));

    verify(quizService).abandonGrading(org.mockito.ArgumentMatchers.eq(9), same(rejected));
    verify(quizService, never()).gradeAttempt(any());
  }
}
