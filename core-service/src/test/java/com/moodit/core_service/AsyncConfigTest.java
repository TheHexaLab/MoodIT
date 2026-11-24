package com.moodit.core_service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.core.task.TaskRejectedException;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * Executors de correction des quiz, vérifiés par leur COMPORTEMENT : le pool du code fait tourner
 * exactement le nombre de corrections réglé (sans attendre que la file soit pleine), et refuse
 * explicitement au-delà de sa file au lieu de bloquer l'appelant.
 */
class AsyncConfigTest {

  @Test
  void quizExecutor_executeHorsDuThreadAppelant() throws Exception {
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
  void quizCodeExecutor_toutesLesPlacesServentAvantLaFile_puisRefus() throws Exception {
    ThreadPoolTaskExecutor executor =
        (ThreadPoolTaskExecutor) new AsyncConfig().quizCodeExecutor(3, 2);
    CountDownLatch started = new CountDownLatch(3);
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch done = new CountDownLatch(5);
    List<String> workers = new CopyOnWriteArrayList<>();
    try {
      for (int i = 0; i < 5; i++) {
        executor.execute(
            () -> {
              workers.add(Thread.currentThread().getName());
              started.countDown();
              try {
                release.await(10, TimeUnit.SECONDS);
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
              }
              done.countDown();
            });
      }
      // Les 3 places tournent déjà alors que la file n'est pas pleine (cœur = maximum).
      assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
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

  @Test
  void quizCodeExecutor_reglageInvalide_refuseAuDemarrage() {
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
