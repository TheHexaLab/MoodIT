package com.moodit.execution_service;

import com.moodit.execution_service.sandbox.DockerEvaluator;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Le CONTEXTE Spring complet démarre (câblage réel des beans). Filet contre les erreurs de
 * construction qui ne se voient qu'au démarrage du service — ex. un bean à plusieurs
 * constructeurs sans {@code @Autowired} (a fait tomber la pile e2e, cf. PR #246). Si un démon
 * Docker répond, le démarrage balaie les conteneurs runner ORPHELINS (removeOrphans) : seulement
 * ceux qui ont dépassé le délai de grâce, jamais une notation en cours d'une autre instance.
 */
@SpringBootTest
class ExecutionServiceApplicationTests {

    @Autowired
    private DockerEvaluator dockerEvaluator;

    @Test
    void contextLoads() {
        assertThat(dockerEvaluator).isNotNull();
        assertThat(dockerEvaluator.imageFor("java")).isEqualTo("moodit-runner-java:latest");
    }
}
