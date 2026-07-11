package com.moodit.core_service;

import java.util.concurrent.Executor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * Active l'exécution asynchrone ({@link org.springframework.scheduling.annotation.Async @Async}) et
 * fournit l'executor dédié à la correction des quiz.
 *
 * <p>La correction d'une tentative lance le sandbox de code (lent : plusieurs secondes) HORS de la
 * requête HTTP. Un pool DÉDIÉ (et non le pool commun) isole cette charge : une rafale de
 * soumissions ne monopolise pas les threads du reste de l'application, et la file borne la
 * concurrence sur le sandbox.
 */
@Configuration
@EnableAsync
public class AsyncConfig {

  @Bean(name = "quizExecutor")
  public Executor quizExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(2);
    executor.setMaxPoolSize(4);
    executor.setQueueCapacity(100);
    executor.setThreadNamePrefix("quiz-grade-");
    executor.initialize();
    return executor;
  }
}
