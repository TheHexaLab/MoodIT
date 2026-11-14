package com.moodit.execution_service.sandbox;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Client Docker PARTAGÉ du sandbox (#116) : une seule instance (et un seul client paresseux)
 * pour la notation des compilés ({@link DockerEvaluator}) et l'exécution générique ex-Piston
 * ({@link RunnerExec}).
 */
@Configuration
public class SandboxBeans {

    @Bean
    public DockerSandbox dockerSandbox(
            @Value("${app.sandbox.docker-host:}") String dockerHost,
            @Value("${app.sandbox.memory-mb:1536}") long memoryMb,
            @Value("${app.sandbox.pids-limit:512}") long pidsLimit,
            @Value("${app.sandbox.cpus:2.0}") double cpus) {
        DockerSandbox sandbox = new DockerSandbox(dockerHost, memoryMb, pidsLimit, cpus);
        // Restes d'une instance précédente tuée en pleine notation (voir removeOrphans()).
        sandbox.removeOrphans();
        return sandbox;
    }
}
