package com.moodit.mcp_service.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * Active @Async et fournit l'executor dédié aux jobs d'analyse MCP. Petit pool borné :
 * les jobs sont peu fréquents (déclenchés à la main) mais longs (appel LLM) — on ne veut
 * ni monopoliser les threads web ni empiler indéfiniment.
 */
@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean("mcpExecutor")
    public Executor mcpExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(50);
        executor.setThreadNamePrefix("mcp-analysis-");
        executor.initialize();
        return executor;
    }
}
