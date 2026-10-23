package com.moodit.mcp_service.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * Executor des jobs d'analyse : pool BORNÉ (les jobs LLM sont longs, on ne veut ni monopoliser
 * les threads web ni empiler sans limite) et threads nommés pour les logs.
 */
class AsyncConfigTest {

    @Test
    void mcpExecutor_estUnPoolBorne_auxThreadsNommes() throws Exception {
        ThreadPoolTaskExecutor executor = (ThreadPoolTaskExecutor) new AsyncConfig().mcpExecutor();
        try {
            assertThat(executor.getCorePoolSize()).isEqualTo(2);
            assertThat(executor.getMaxPoolSize()).isEqualTo(4);
            assertThat(executor.getQueueCapacity()).isEqualTo(50);

            // Déjà initialisé : exécute immédiatement, sur un thread « mcp-analysis-* ».
            String threadName = CompletableFuture
                    .supplyAsync(() -> Thread.currentThread().getName(), executor)
                    .get(5, TimeUnit.SECONDS);
            assertThat(threadName).startsWith("mcp-analysis-");
        } finally {
            executor.shutdown();
        }
    }
}
