package com.moodit.mcp_service.config;

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
 * Executor des jobs d'analyse, vérifié par son COMPORTEMENT (et non ses constantes) : jobs exécutés
 * hors du thread appelant sur des threads « mcp-analysis-* », au plus 4 en parallèle, 50 en file,
 * et au-delà un refus explicite ({@link TaskRejectedException}) plutôt qu'une file sans fin.
 */
class AsyncConfigTest {

    @Test
    void mcpExecutor_executeHorsDuThreadAppelant_surDesThreadsNommes() throws Exception {
        ThreadPoolTaskExecutor executor = (ThreadPoolTaskExecutor) new AsyncConfig().mcpExecutor();
        try {
            // Déjà initialisé : exécute immédiatement, sur un thread « mcp-analysis-* ».
            String threadName = CompletableFuture
                    .supplyAsync(() -> Thread.currentThread().getName(), executor)
                    .get(5, TimeUnit.SECONDS);

            assertThat(threadName).startsWith("mcp-analysis-").isNotEqualTo(Thread.currentThread().getName());
        } finally {
            executor.shutdown();
        }
    }

    @Test
    void mcpExecutor_sature_borneLeParallelisme_puisRefuseSansBloquerLAppelant() throws Exception {
        ThreadPoolTaskExecutor executor = (ThreadPoolTaskExecutor) new AsyncConfig().mcpExecutor();
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(54);
        List<String> workers = new CopyOnWriteArrayList<>();
        try {
            // 4 jobs en cours + 50 en file : le pool est plein.
            for (int i = 0; i < 54; i++) {
                executor.execute(() -> {
                    workers.add(Thread.currentThread().getName());
                    try {
                        release.await(10, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    done.countDown();
                });
            }
            assertThat(executor.getThreadPoolExecutor().getPoolSize()).isEqualTo(4);
            assertThat(executor.getThreadPoolExecutor().getQueue()).hasSize(50);

            // Le 55e job est refusé tout de suite (pas exécuté dans le thread appelant).
            List<String> overflow = new CopyOnWriteArrayList<>();
            assertThatThrownBy(() -> executor.execute(() -> overflow.add(Thread.currentThread().getName())))
                    .isInstanceOf(TaskRejectedException.class);
            assertThat(overflow).isEmpty();

            // Les jobs acceptés vont tous au bout, sur les 4 threads du pool.
            release.countDown();
            assertThat(done.await(10, TimeUnit.SECONDS)).isTrue();
            assertThat(workers).hasSize(54).allSatisfy(name -> assertThat(name).startsWith("mcp-analysis-"));
            assertThat(workers.stream().distinct().count()).isEqualTo(4);
        } finally {
            release.countDown();
            executor.shutdown();
        }
    }
}
