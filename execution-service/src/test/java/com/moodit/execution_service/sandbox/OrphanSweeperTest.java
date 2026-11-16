package com.moodit.execution_service.sandbox;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class OrphanSweeperTest {

    @Test
    void le_balayage_periodique_appelle_removeOrphans() throws Exception {
        DockerSandbox sandbox = mock(DockerSandbox.class);

        new OrphanSweeper(sandbox).sweep();

        verify(sandbox).removeOrphans();
        // Planifié, et la planification est activée : sans @EnableScheduling, @Scheduled ne
        // fait rien, et l'orphelin d'un redéploiement n'était jamais ramassé.
        Scheduled planif = OrphanSweeper.class.getMethod("sweep").getAnnotation(Scheduled.class);
        assertThat(planif).isNotNull();
        assertThat(planif.fixedDelayString()).contains("orphan-sweep-ms");
        assertThat(SandboxBeans.class.getAnnotation(EnableScheduling.class)).isNotNull();
    }
}
