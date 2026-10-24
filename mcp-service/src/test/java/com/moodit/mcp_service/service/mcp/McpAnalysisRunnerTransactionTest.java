package com.moodit.mcp_service.service.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.moodit.mcp_service.model.Course;
import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;
import com.moodit.mcp_service.model.User;
import com.moodit.mcp_service.repository.CourseStatsRepository;
import com.moodit.mcp_service.repository.McpResponseRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.AbstractPlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

/**
 * {@link McpAnalysisRunner#markRejected} est appelé depuis {@code afterCommit} : la transaction
 * d'origine est validée mais encore liée au fil. Sans transaction NOUVELLE, l'écriture du FAILED
 * rejoindrait cette transaction terminée et ne serait jamais enregistrée (ligne bloquée en PENDING).
 * Un vrai proxy transactionnel (contexte Spring) et un gestionnaire qui note chaque ouverture et
 * chaque validation le vérifient ; des mocks seuls ne peuvent pas le voir.
 */
class McpAnalysisRunnerTransactionTest {

    /** Gestionnaire minimal : une transaction est « existante » tant qu'elle n'est pas nettoyée. */
    static class RecordingTxManager extends AbstractPlatformTransactionManager {
        final List<String> events = new ArrayList<>();
        private final ThreadLocal<Integer> depth = ThreadLocal.withInitial(() -> 0);

        @Override
        protected Object doGetTransaction() {
            return new Object();
        }

        @Override
        protected boolean isExistingTransaction(Object tx) {
            return depth.get() > 0;
        }

        @Override
        protected void doBegin(Object tx, TransactionDefinition def) {
            depth.set(depth.get() + 1);
            events.add("begin");
        }

        @Override
        protected Object doSuspend(Object tx) {
            int suspended = depth.get();
            depth.set(0);
            return suspended;
        }

        @Override
        protected void doResume(Object tx, Object suspended) {
            depth.set((Integer) suspended);
        }

        @Override
        protected void doCommit(DefaultTransactionStatus status) {
            events.add("commit");
        }

        @Override
        protected void doRollback(DefaultTransactionStatus status) {
            events.add("rollback");
        }

        @Override
        protected void doCleanupAfterCompletion(Object tx) {
            depth.set(Math.max(0, depth.get() - 1));
        }
    }

    @Configuration
    @EnableTransactionManagement
    static class Config {
        @Bean
        RecordingTxManager transactionManager() {
            return new RecordingTxManager();
        }

        @Bean
        McpResponseRepository mcpResponseRepository() {
            return mock(McpResponseRepository.class);
        }

        @Bean
        McpRealtimeGateway realtimeGateway() {
            return mock(McpRealtimeGateway.class);
        }

        @Bean
        McpAnalysisRunner runner(McpResponseRepository repo, McpRealtimeGateway gateway) {
            return new McpAnalysisRunner(repo, mock(CourseStatsRepository.class),
                    mock(CoreQuizStatsClient.class), mock(McpAnalysisClient.class), gateway, new ObjectMapper());
        }
    }

    @Test
    void markRejected_depuisAfterCommit_ecritDansUneNouvelleTransactionValidee() {
        try (var ctx = new AnnotationConfigApplicationContext(Config.class)) {
            RecordingTxManager tx = ctx.getBean(RecordingTxManager.class);
            McpResponseRepository repo = ctx.getBean(McpResponseRepository.class);
            McpAnalysisRunner runner = ctx.getBean(McpAnalysisRunner.class);

            Course course = new Course();
            course.setId(10);
            User user = new User();
            user.setId(5);
            McpResponse pending = new McpResponse();
            pending.setId(1);
            pending.setCourse(course);
            pending.setUser(user);
            pending.setStatus(McpStatus.PENDING);
            when(repo.findById(1)).thenReturn(Optional.of(pending));
            // Pendant l'écriture, on note combien de transactions ont été ouvertes jusque-là.
            List<Long> beginsAtSave = new ArrayList<>();
            when(repo.save(any(McpResponse.class))).thenAnswer(inv -> {
                beginsAtSave.add(tx.events.stream().filter("begin"::equals).count());
                return inv.getArgument(0);
            });

            // Même enchaînement que McpService.requestAnalysis : transaction d'origine, puis
            // markRejected dans son afterCommit (file d'analyse pleine).
            new TransactionTemplate(tx).executeWithoutResult(status ->
                    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                        @Override
                        public void afterCommit() {
                            runner.markRejected(1);
                        }
                    }));

            assertThat(pending.getStatus()).isEqualTo(McpStatus.FAILED);
            // Origine : begin, commit ; puis la transaction NOUVELLE de markRejected : begin, commit.
            assertThat(tx.events).containsExactly("begin", "commit", "begin", "commit");
            assertThat(beginsAtSave).containsExactly(2L); // l'écriture a lieu dans la 2e transaction
        }
    }
}
