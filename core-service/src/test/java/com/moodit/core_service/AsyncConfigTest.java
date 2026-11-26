package com.moodit.core_service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.support.StaticApplicationContext;
import org.springframework.core.task.TaskRejectedException;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * Executors de correction des quiz, vérifiés par leur COMPORTEMENT : le pool du code fait tourner
 * autant de corrections simultanées que de fils réglés sans en mettre aucune en file (cœur =
 * maximum), met les suivantes en file, et refuse explicitement au-delà de sa file au lieu de
 * bloquer l'appelant.
 */
class AsyncConfigTest {

  @Test
  void quizExecutor_runsOffTheCallerThread() throws Exception {
    ThreadPoolTaskExecutor executor = (ThreadPoolTaskExecutor) new AsyncConfig().quizExecutor();
    try {
      String threadName =
          CompletableFuture.supplyAsync(() -> Thread.currentThread().getName(), executor)
              .get(5, TimeUnit.SECONDS);
      assertThat(threadName).startsWith("quiz-grade-");
    } finally {
      executor.shutdown();
    }
  }

  @Test
  void quizCodeExecutor_fillsEveryThreadBeforeQueueing_thenRejects() throws Exception {
    ThreadPoolTaskExecutor executor =
        (ThreadPoolTaskExecutor) new AsyncConfig().quizCodeExecutor(3, 2);
    CountDownLatch started = new CountDownLatch(3);
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch done = new CountDownLatch(5);
    List<String> workers = new CopyOnWriteArrayList<>();
    Runnable blocking =
        () -> {
          workers.add(Thread.currentThread().getName());
          started.countDown();
          try {
            release.await(10, TimeUnit.SECONDS);
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
          }
          done.countDown();
        };
    try {
      // Autant de tâches que de fils, et pas une de plus : les 3 démarrent alors que la file est
      // VIDE. Un pool au cœur plus petit que son maximum mettrait les 2e et 3e en file (un
      // ThreadPoolExecutor ne crée de fil au-delà du cœur qu'une fois la file pleine) : seul le
      // réglage cœur = maximum fait tourner les 3 corrections sans attendre.
      for (int i = 0; i < 3; i++) {
        executor.execute(blocking);
      }
      assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
      assertThat(executor.getThreadPoolExecutor().getQueue()).isEmpty();

      // Les fils occupés, les suivantes attendent dans la file, puis le refus au-delà.
      for (int i = 0; i < 2; i++) {
        executor.execute(blocking);
      }
      assertThat(executor.getThreadPoolExecutor().getQueue()).hasSize(2);
      assertThatThrownBy(() -> executor.execute(() -> {}))
          .isInstanceOf(TaskRejectedException.class);

      release.countDown();
      assertThat(done.await(10, TimeUnit.SECONDS)).isTrue();
      assertThat(workers).allSatisfy(name -> assertThat(name).startsWith("quiz-code-grade-"));
      assertThat(workers.stream().distinct().count()).isEqualTo(3);
    } finally {
      release.countDown();
      executor.shutdown();
    }
  }

  /**
   * Rejoue sur l'executor le début de la fermeture de SON contexte, dans l'ordre de Spring :
   * {@link ContextClosedEvent}, puis arrêt coordonné de la phase de cycle de vie
   * ({@code stop(callback)}, avant la destruction des beans). Rend le signal de fin de cet arrêt.
   */
  private static CountDownLatch closeContextOf(ThreadPoolTaskExecutor executor) {
    StaticApplicationContext context = new StaticApplicationContext();
    executor.setApplicationContext(context);
    executor.onApplicationEvent(new ContextClosedEvent(context));
    CountDownLatch stopped = new CountDownLatch(1);
    executor.stop(stopped::countDown);
    return stopped;
  }

  /** Occupe un fil de l'executor jusqu'à {@code release} ; rend quand la tâche a démarré. */
  private static void occupyOneThread(ThreadPoolTaskExecutor executor, CountDownLatch release)
      throws InterruptedException {
    CountDownLatch started = new CountDownLatch(1);
    executor.execute(
        () -> {
          started.countDown();
          try {
            release.await(10, TimeUnit.SECONDS);
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
          }
        });
    assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
  }

  @Test
  void executors_keepRunningUntilDestroyed() throws Exception {
    // Fermeture du contexte pendant une correction : l'arrêt coordonné du cycle de vie n'attend
    // pas la fin de la correction (plusieurs dizaines de minutes, cf. ExecutionClient#readTimeoutMs), l'executor reste actif et accepte puis
    // exécute encore une soumission (ou une relance) qui commit pendant l'arrêt gracieux du
    // serveur web. La correction en cours sera interrompue à la destruction et restera pending
    // pour la reprise au démarrage.
    for (Executor e : List.of(new AsyncConfig().quizExecutor(), new AsyncConfig().quizCodeExecutor(1, 1))) {
      ThreadPoolTaskExecutor executor = (ThreadPoolTaskExecutor) e;
      CountDownLatch release = new CountDownLatch(1);
      try {
        occupyOneThread(executor, release);
        CountDownLatch stopped = closeContextOf(executor);
        assertThat(stopped.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(executor.isRunning()).isTrue();

        CountDownLatch ran = new CountDownLatch(1);
        executor.execute(ran::countDown);
        release.countDown();
        assertThat(ran.await(5, TimeUnit.SECONDS)).isTrue();
      } finally {
        release.countDown();
        executor.shutdown();
      }
    }
  }

  @Test
  void defaultExecutor_stopWaitsForRunningTasks() throws Exception {
    // Témoin, qui rend le test précédent discriminant : sans acceptUntilDestroyed, l'executor
    // se met en pause à l'arrêt du cycle de vie et cet arrêt attend la fin des tâches en cours.
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.initialize();
    CountDownLatch release = new CountDownLatch(1);
    try {
      occupyOneThread(executor, release);
      CountDownLatch stopped = closeContextOf(executor);
      assertThat(stopped.await(300, TimeUnit.MILLISECONDS)).isFalse();
      assertThat(executor.isRunning()).isFalse();
      release.countDown();
      assertThat(stopped.await(5, TimeUnit.SECONDS)).isTrue();
    } finally {
      release.countDown();
      executor.shutdown();
    }
  }

  @Test
  void quizCodeExecutor_invalidSetting_failsAtStartup() {
    assertThatThrownBy(() -> new AsyncConfig().quizCodeExecutor(0, 10))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new AsyncConfig().quizCodeExecutor(2, -1))
        .isInstanceOf(IllegalArgumentException.class);
    // Bornes exactes acceptées : un fil, file vide (passage direct).
    ThreadPoolTaskExecutor minimal = (ThreadPoolTaskExecutor) new AsyncConfig().quizCodeExecutor(1, 0);
    try {
      assertThat(minimal.getCorePoolSize()).isEqualTo(1);
      assertThat(minimal.getQueueCapacity()).isZero();
    } finally {
      minimal.shutdown();
    }
  }
}
