package com.moodit.execution_service.sandbox;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class OrphanSweeperTest {

    @Test
    void periodic_sweep_calls_removeOrphans() throws Exception {
        DockerSandbox sandbox = mock(DockerSandbox.class);

        new OrphanSweeper(sandbox).sweep();

        // Préchauffage du nombre de CPU de l'hôte AVANT le balayage (premier passage dès le
        // démarrage, hors du fil principal), puis le balayage lui-même.
        var order = org.mockito.Mockito.inOrder(sandbox);
        order.verify(sandbox).warmUpCpuLimit();
        order.verify(sandbox).removeOrphans();
        // Planifié, et la planification est activée : sans @EnableScheduling, @Scheduled ne
        // fait rien, et l'orphelin d'un redéploiement n'était jamais ramassé.
        Scheduled schedule = OrphanSweeper.class.getMethod("sweep").getAnnotation(Scheduled.class);
        assertThat(schedule).isNotNull();
        assertThat(schedule.fixedDelayString()).contains("orphan-sweep-ms");
        // Premier passage dès le démarrage : il remplace le balayage retiré de la fabrique du bean.
        assertThat(schedule.initialDelayString()).isEqualTo("${app.sandbox.orphan-sweep-initial-ms:0}");
        assertThat(SandboxBeans.class.getAnnotation(EnableScheduling.class)).isNotNull();
    }
}
