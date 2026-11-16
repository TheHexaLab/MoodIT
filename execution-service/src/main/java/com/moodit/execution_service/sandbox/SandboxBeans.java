package com.moodit.execution_service.sandbox;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Client Docker PARTAGÉ du sandbox (#116) : une seule instance (et un seul client paresseux)
 * pour la notation des compilés ({@link DockerEvaluator}) et l'exécution générique ex-Piston
 * ({@link RunnerExec}).
 */
@Configuration
@EnableScheduling   // OrphanSweeper : balayage périodique des orphelins
public class SandboxBeans {

    @Bean
    public DockerSandbox dockerSandbox(
            @Value("${app.sandbox.docker-host:}") String dockerHost,
            @Value("${app.sandbox.memory-mb:1536}") long memoryMb,
            @Value("${app.sandbox.pids-limit:512}") long pidsLimit,
            @Value("${app.sandbox.cpus:2.0}") double cpus) {
        // Pas de balayage des orphelins ici : un démon muet bloquerait le démarrage du service.
        // OrphanSweeper s'en charge dès le démarrage du planificateur, hors du fil principal.
        return new DockerSandbox(dockerHost, memoryMb, pidsLimit, cpus);
    }
}
