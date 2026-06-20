// Active l'exécution asynchrone et définit un pool borné dédié aux envois d'email,
// pour que la latence SMTP ne bloque pas les requêtes HTTP (register / login / 2FA).

package com.moodit.auth_service.config;

import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

@Configuration
@EnableAsync
public class AsyncConfig {

  // Pool borné : évite la création illimitée de threads sous un pic d'envois.
  // CallerRunsPolicy : si le pool ET la file sont saturés, l'envoi retombe en synchrone dans
  // le thread appelant (dégradation gracieuse) plutôt que d'être rejeté (500) ou perdu.
  @Bean(name = "emailExecutor")
  public Executor emailExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(2);
    executor.setMaxPoolSize(5);
    executor.setQueueCapacity(50);
    executor.setThreadNamePrefix("email-");
    executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
    executor.initialize();
    return executor;
  }
}
