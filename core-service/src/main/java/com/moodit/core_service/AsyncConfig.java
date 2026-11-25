package com.moodit.core_service;

import java.util.concurrent.Executor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * Active l'exécution asynchrone ({@link org.springframework.scheduling.annotation.Async @Async}) et
 * fournit les deux executors de correction des quiz (cf. QuizGradingListener).
 *
 * <p>La correction d'une tentative tourne HORS de la requête HTTP, sur un pool DÉDIÉ (et non le
 * pool commun) : une rafale de soumissions ne monopolise pas les threads du reste de l'application.
 * Deux pools, parce que les deux charges n'ont rien en commun (#116) :
 *
 * <ul>
 *   <li>{@code quizExecutor} : quiz SANS harnais de code. Correction en BD seulement, en quelques
 *       millisecondes ; elle ne doit jamais attendre derrière une correction compilée.
 *   <li>{@code quizCodeExecutor} : quiz AVEC harnais. Une correction tient une place
 *       d'execution-service pendant tout son conteneur runner (jusqu'à plusieurs minutes pour un
 *       langage compilé). Le nombre de threads ({@code QUIZ_CODE_GRADING_THREADS}) est à aligner
 *       sur {@code EXEC_MAX_CONCURRENT - 1}, les places qu'execution-service accorde aux
 *       corrections (la dernière reste à « Exécuter »/« Tester » ; une seule de ces places est
 *       hors d'atteinte des appels publics, cf. {@code ExecutionLimiter}) : moins laisse des places
 *       inutilisées, plus fait attendre des corrections dans la file d'execution-service jusqu'à
 *       leur abandon (tentative supprimée, sauf relance de l'enseignant, ou plafond d'échecs atteint sur un quiz sans reprise, gardée « à revoir », cf. QuizService#failGrading).
 *       Cœur = maximum, car un {@link ThreadPoolTaskExecutor} ne dépasse son cœur qu'une fois
 *       la file pleine.
 * </ul>
 *
 * <p>Une tâche refusée (file pleine) n'est jamais perdue en silence : le listener abandonne alors la
 * correction et prévient l'étudiant — tentative pending supprimée (il peut resoumettre), ou gardée
 * « à revoir » selon les règles de QuizService#failGrading (relance, ou plafond atteint sur un échec sans verdict ou sur un quiz sans reprise).
 * Les files vivent en mémoire : une correction perdue par un arrêt de core est reprise au
 * démarrage suivant (cf. QuizGradingListener#resumePendingGradings).
 */
@Configuration
@EnableAsync
public class AsyncConfig {

  @Bean(name = "quizExecutor")
  public Executor quizExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(2);
    executor.setMaxPoolSize(4);
    executor.setQueueCapacity(100);
    executor.setThreadNamePrefix("quiz-grade-");
    acceptUntilDestroyed(executor);
    executor.initialize();
    return executor;
  }

  @Bean(name = "quizCodeExecutor")
  public Executor quizCodeExecutor(
      @Value("${app.quiz.grading.code-threads:3}") int threads,
      @Value("${app.quiz.grading.code-queue-capacity:500}") int queueCapacity) {
    if (threads < 1 || queueCapacity < 0) {
      throw new IllegalArgumentException(
          "app.quiz.grading.code-threads doit valoir au moins 1 et la file être positive");
    }
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(threads);
    executor.setMaxPoolSize(threads);
    executor.setQueueCapacity(queueCapacity);
    executor.setThreadNamePrefix("quiz-code-grade-");
    acceptUntilDestroyed(executor);
    executor.initialize();
    return executor;
  }

  /**
   * Garde l'executor ACTIF jusqu'à sa destruction. Par défaut (Spring 7), la fermeture du contexte
   * le met en pause à l'arrêt du cycle de vie, et cet arrêt attend les tâches en cours — une
   * correction compilée peut durer jusqu'à 15 min. Avec ce réglage, l'arrêt n'attend pas,
   * l'executor reste en marche et exécute encore une soumission (ou une relance) qui commit pendant
   * l'arrêt gracieux du serveur web. Une correction que la destruction interrompt reste
   * {@code pending}, et la reprise au démarrage la corrige ({@code resumePendingGradings}).
   * Comportement épinglé par {@code AsyncConfigTest}.
   */
  static void acceptUntilDestroyed(ThreadPoolTaskExecutor executor) {
    executor.setAcceptTasksAfterContextClose(true);
  }
}
