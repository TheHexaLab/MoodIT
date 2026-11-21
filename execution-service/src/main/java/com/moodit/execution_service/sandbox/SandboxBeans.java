package com.moodit.execution_service.sandbox;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.context.event.ContextClosedEvent;
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

    /**
     * Arrêt du service : suppression des conteneurs en vol DÈS la fermeture du contexte.
     * {@code ContextClosedEvent} est publié avant l'arrêt progressif du serveur web
     * ({@code server.shutdown=graceful}, défaut de Spring Boot) : celui-ci attend les requêtes
     * actives jusqu'à 30 s, alors que Docker tue le service 10 s après SIGTERM — attendre la
     * destruction des beans, c'était ne jamais s'exécuter dès qu'une notation avait plus de 10 s
     * devant elle. La requête en cours finit en 502 (panne, jamais une note).
     */
    @Bean
    public ApplicationListener<ContextClosedEvent> inFlightContainerCleanup(
            DockerSandbox sandbox, ApplicationContext context) {
        // Seulement la fermeture de CE contexte : l'événement d'un contexte ENFANT remonte au
        // parent, et removeInFlight est sans retour (plus aucun conteneur lancé ensuite) — la
        // fermeture d'un enfant aurait rendu toute notation impossible jusqu'au redémarrage.
        return event -> {
            if (event.getApplicationContext() == context) {
                sandbox.removeInFlight();
            }
        };
    }

    // Filet : même suppression à la destruction du bean (contexte fermé sans l'événement).
    @Bean(destroyMethod = "removeInFlight")
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
