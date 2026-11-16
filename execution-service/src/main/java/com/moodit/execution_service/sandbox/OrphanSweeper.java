package com.moodit.execution_service.sandbox;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Balayage PÉRIODIQUE des conteneurs runner orphelins. Au démarrage seul, il ne suffisait pas :
 * un service tué en pleine correction (déploiement, OOM) repart aussitôt, et ses conteneurs,
 * trop récents pour {@link DockerSandbox#ORPHAN_GRACE_MS}, n'étaient plus jamais ramassés. Le
 * délai de grâce reste la seule règle : une correction en cours n'est jamais touchée.
 */
@Component
public class OrphanSweeper {

    private final DockerSandbox sandbox;

    public OrphanSweeper(DockerSandbox sandbox) {
        this.sandbox = sandbox;
    }

    @Scheduled(initialDelayString = "${app.sandbox.orphan-sweep-ms:600000}",
            fixedDelayString = "${app.sandbox.orphan-sweep-ms:600000}")
    public void sweep() {
        sandbox.removeOrphans();
    }
}
