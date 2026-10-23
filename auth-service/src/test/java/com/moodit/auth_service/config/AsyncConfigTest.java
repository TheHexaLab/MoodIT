package com.moodit.auth_service.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;
import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

class AsyncConfigTest {

  @Test
  void emailExecutor_isBoundedPool_withCallerRunsFallback() {
    Executor executor = new AsyncConfig().emailExecutor();

    assertThat(executor).isInstanceOf(ThreadPoolTaskExecutor.class);
    ThreadPoolTaskExecutor pool = (ThreadPoolTaskExecutor) executor;
    try {
      assertThat(pool.getCorePoolSize()).isEqualTo(2);
      assertThat(pool.getMaxPoolSize()).isEqualTo(5);
      assertThat(pool.getQueueCapacity()).isEqualTo(50);
      assertThat(pool.getThreadNamePrefix()).isEqualTo("email-");
      // Saturation : l'envoi retombe en synchrone plutôt que d'être rejeté ou perdu.
      assertThat(pool.getThreadPoolExecutor().getRejectedExecutionHandler())
          .isInstanceOf(ThreadPoolExecutor.CallerRunsPolicy.class);
    } finally {
      pool.shutdown();
    }
  }

  @Test
  void emailExecutor_runsTasksOnDedicatedEmailThreads() throws Exception {
    ThreadPoolTaskExecutor pool = (ThreadPoolTaskExecutor) new AsyncConfig().emailExecutor();
    try {
      String threadName = pool.submit(() -> Thread.currentThread().getName()).get();

      assertThat(threadName).startsWith("email-");
    } finally {
      pool.shutdown();
    }
  }
}
