package com.moodit.auth_service.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

// Comportement du pool d'envoi d'emails (et non ses constantes) : tâches exécutées hors du thread
// appelant, sur des threads « email- », au plus 5 en parallèle, file de 50 ; au-delà, l'envoi
// retombe en synchrone dans l'appelant au lieu d'être rejeté ou perdu.
class AsyncConfigTest {

  @Test
  void emailExecutor_executeHorsDuThreadAppelant_surDesThreadsEmail() throws Exception {
    ThreadPoolTaskExecutor pool = (ThreadPoolTaskExecutor) new AsyncConfig().emailExecutor();
    try {
      String threadName = pool.submit(() -> Thread.currentThread().getName()).get(5, TimeUnit.SECONDS);

      assertThat(threadName).startsWith("email-").isNotEqualTo(Thread.currentThread().getName());
    } finally {
      pool.shutdown();
    }
  }

  @Test
  void emailExecutor_sature_borneLeParallelisme_puisRetombeEnSynchroneSansPerte() throws Exception {
    ThreadPoolTaskExecutor pool = (ThreadPoolTaskExecutor) new AsyncConfig().emailExecutor();
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch done = new CountDownLatch(55);
    List<String> workers = new CopyOnWriteArrayList<>();
    try {
      // 5 threads occupés + 50 tâches en file : le pool est plein.
      for (int i = 0; i < 55; i++) {
        pool.execute(
            () -> {
              workers.add(Thread.currentThread().getName());
              try {
                release.await(10, TimeUnit.SECONDS);
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
              }
              done.countDown();
            });
      }
      assertThat(pool.getThreadPoolExecutor().getPoolSize()).isEqualTo(5);
      assertThat(pool.getThreadPoolExecutor().getQueue()).hasSize(50);

      // La 56e tâche n'est ni rejetée ni perdue : elle s'exécute dans le thread appelant.
      AtomicReference<String> overflow = new AtomicReference<>();
      pool.execute(() -> overflow.set(Thread.currentThread().getName()));
      assertThat(overflow.get()).isEqualTo(Thread.currentThread().getName());

      release.countDown();
      assertThat(done.await(10, TimeUnit.SECONDS)).isTrue();
      assertThat(workers).hasSize(55).allSatisfy(name -> assertThat(name).startsWith("email-"));
      assertThat(workers.stream().distinct().count()).isEqualTo(5);
    } finally {
      release.countDown();
      pool.shutdown();
    }
  }
}
