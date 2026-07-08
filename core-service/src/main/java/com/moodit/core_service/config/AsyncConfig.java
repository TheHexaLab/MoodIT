package com.moodit.core_service.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * Active @Async et fournit l'executor de la correction de code (exécution sandbox, lente). Pool
 * borné : correction déclenchée après chaque soumission d'un quiz avec des questions Code.
 */
@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean("codeGradingExecutor")
    public Executor codeGradingExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("code-grading-");
        executor.initialize();
        return executor;
    }
}
