package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.QuestionResultDTO;
import com.moodit.core_service.dto.QuizDTO;
import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.dto.SubmittedAnswerDTO;
import com.moodit.core_service.model.Attempt;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Language;
import com.moodit.core_service.model.QType;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.TestCase;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.AttemptRepository;
import java.time.LocalDateTime;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.transaction.TestTransaction;

/**
 * Test d'intégration de la soumission ASYNCHRONE sur H2 (schéma généré depuis les entités).
 * {@link QuizService#submitQuiz} persiste la tentative en {@code "pending"} (+ réponses brutes) et
 * rend un id ; {@link QuizService#gradeAttempt} — déclenché ici MANUELLEMENT (le listener async
 * n'est pas chargé dans ce slice) — corrige le code :
 *   1. exécution indisponible → la tentative pending est SUPPRIMÉE (rien ne subsiste, l'étudiant
 *      peut renvoyer sans consommer sa tentative) ;
 *   2. exécution réussie → verdicts persistés, tentative {@code "done"}, question Code notée ;
 *   3. plafond des échecs sans verdict (#116, S4) → au troisième, la tentative est GARDÉE « à
 *      revoir » (historique, tentative unique consommée, liste de l'enseignant), puis la relance
 *      de l'enseignant la note et remet le compte à zéro ;
 *   4. relance qui échoue sur un quiz avec reprise → la tentative reste « à revoir » pendant la
 *      relance et y revient après l'échec, même si une autre tentative corrigée a remis le
 *      compte à zéro ; une seconde relance qui aboutit la note et retire le marqueur.
 *   5. compteur « à revoir » de l'éditeur → la requête par cours, statut et quiz, interrogée sur la
 *      vraie base (sans commit, dans la transaction du test).
 *   6. deux soumissions de suite → la 2e est refusée « correction en cours »
 *      ({@code GradingInProgressException}), avec ou sans reprise, et non « déjà soumis » ;
 *      pendant une relance de l'enseignant, elle est refusée « relance »
 *      ({@code RegradeInProgressException}) avec reprise, « déjà soumis » sans reprise.
 * Les scénarios 1, 3 et 4 committent leurs données (chaque correction tourne dans ses propres
 * transactions, comme en prod) ; {@link #purgeCommitted} les efface.
 * {@link ExecutionClient} est mocké (pas de sandbox dans un test).
 */
@DataJpaTest
@Import({QuizService.class, AuditLogService.class, QuizItemObfuscator.class})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:moodit_submit_it;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE;NON_KEYWORDS=ROLE,USER,VALUE,LANGUAGE,POSITION",
      "spring.datasource.driver-class-name=org.h2.Driver",
      "spring.datasource.username=sa",
      "spring.datasource.password=",
      "spring.jpa.hibernate.ddl-auto=create-drop",
      // Les scénarios du plafond comptent trois échecs : le figer, quel que soit le .env local.
      "app.quiz.grading.max-no-verdict-failures=3"
    })
class QuizServiceSubmitIT {

  // QuizService a besoin d'un ObjectMapper (sérialisation des réponses) : non fourni par le slice JPA.
  @TestConfiguration
  static class Config {
    @Bean
    ObjectMapper objectMapper() {
      return new ObjectMapper();
    }
  }

  @Autowired private QuizService quizService;
  @Autowired private TestEntityManager em;
  @Autowired private AttemptRepository attemptRepository;

  // Dépendances hors périmètre JPA : mockées.
  @MockitoBean private RealtimeEventPublisher realtimePublisher;
  @MockitoBean private ExecutionClient executionClient;

  private static final String USER_EMAIL = "eva@test.ca";
  private Integer quizId;
  private Integer questionId;
  /** Vrai si le test a committé ses données : elles survivent alors au rollback et sont purgées. */
  private boolean committed;

  @BeforeEach
  void seed() {
    Course course = Course.builder().title("Cours").code("C1").build();
    em.persist(course);

    QType codeType = QType.builder().name("Code").build();
    em.persist(codeType);

    Language language = new Language();
    language.setName("python");
    em.persist(language);

    Quiz quiz = Quiz.builder()
        .title("Quiz code").isDaily(false).isPublished(true).allowRetry(false)
        .position(0).createdAt(LocalDateTime.now()).course(course).build();
    em.persist(quiz);

    Question question = new Question();
    question.setPrompt("Écris une fonction");
    question.setTotalScore(10.0);
    question.setOrderIndex(0);
    question.setQType(codeType);
    question.setLanguage(language);
    question.setQuiz(quiz);
    em.persist(question);

    TestCase testCase = new TestCase();
    testCase.setName("cas 1");
    testCase.setHarnessCode("assert solution() == 1");
    testCase.setWeight(1);
    testCase.setQuestion(question);
    em.persist(testCase);

    User user = User.builder()
        .username("eva").firstName("Éva").lastName("Test")
        .email(USER_EMAIL).passwordHash("hash").build();
    em.persist(user);

    quizId = quiz.getId();
    questionId = question.getId();

    em.flush();
    em.clear();
  }

  @Test
  @DisplayName("Correction indisponible → tentative pending SUPPRIMÉE (rien ne subsiste, renvoi possible)")
  void grade_whenExecutionUnavailable_deletesAttempt() {
    // Sandbox injoignable → l'ExecutionClient renvoie null.
    when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(null);

    // Soumission : persiste la tentative 'pending' + la réponse (async, rend l'id).
    Integer attemptId = quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL);
    assertThat(attemptId).isNotNull();

    // Comme en prod : la tentative est COMMITTÉE avant la correction, qui tourne ensuite hors de
    // toute transaction. La suppression se fait dans une transaction NOUVELLE (REQUIRES_NEW) :
    // laissée dans la transaction du test, la tentative lui resterait invisible et survivrait.
    TestTransaction.flagForCommit();
    TestTransaction.end();
    committed = true;

    // Correction (déclenchée manuellement) : code inévaluable → la tentative est supprimée.
    quizService.gradeAttempt(attemptId);

    TestTransaction.start();
    // Rien ne subsiste : la tentative unique n'est pas consommée.
    assertThat(count("SELECT count(*) FROM attempt")).isZero();
    assertThat(count("SELECT count(*) FROM submission")).isZero();
    assertThat(count("SELECT count(*) FROM submission_test_case")).isZero();
  }

  @Test
  @DisplayName("Correction réussie → verdicts persistés, tentative 'done' et question Code notée")
  void grade_whenExecutionSucceeds_persistsVerdictsAndGrades() {
    // Le harnais unique passe.
    when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(List.of(true));

    Integer attemptId = quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL);
    // Contexte frais : le job async relit la tentative dans une nouvelle transaction.
    em.flush();
    em.clear();

    quizService.gradeAttempt(attemptId);

    // Relit depuis la base (contexte vidé) : verdicts et statut 'done' bien persistés.
    em.flush();
    em.clear();

    QuizResultDTO result = quizService.getAttemptResult(attemptId, USER_EMAIL);
    QuestionResultDTO codeResult = result.getQuestions().stream()
        .filter(q -> q.getQuestionId().equals(questionId))
        .findFirst()
        .orElseThrow();
    // tests non-null (plus de « en cours ») + score plein (harnais réussi sur barème 10).
    assertThat(codeResult.getTests()).isNotNull().hasSize(1);
    assertThat(codeResult.getEarned()).isEqualTo(10.0);
    // Le code RÉELLEMENT soumis est renvoyé (affiché en révision, cf. front CodingQuestion).
    assertThat(codeResult.getSubmittedCode()).isEqualTo("print(1)");

    assertThat(count("SELECT count(*) FROM attempt WHERE status = 'done'")).isEqualTo(1L);
    assertThat(count("SELECT count(*) FROM submission")).isEqualTo(1L);
    assertThat(count("SELECT count(*) FROM submission_test_case WHERE passed = TRUE")).isEqualTo(1L);
  }

  @Test
  @DisplayName("Plafond (#116, S4) : 3 échecs sans verdict → tentative gardée à revoir, relance → notée, compte remis à zéro")
  void noVerdictCap_keepsAttemptForReview_thenRegradeGrades() {
    when(executionClient.evaluate(any(), any(), any(), any(), any()))
        .thenThrow(new com.moodit.core_service.exception.CodeVerificationNoVerdictException());
    // Les données de départ doivent être committées : chaque correction tourne dans ses propres
    // transactions, comme en prod.
    TestTransaction.flagForCommit();
    TestTransaction.end();
    committed = true;

    Integer attemptId = null;
    for (int failure = 1; failure <= 3; failure++) {
      TestTransaction.start();
      attemptId = quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL);
      TestTransaction.flagForCommit();
      TestTransaction.end();

      quizService.gradeAttempt(attemptId);

      TestTransaction.start();
      assertThat(count("SELECT no_verdict_count FROM grading_failure")).isEqualTo(failure);
      // En deçà du plafond, la tentative est supprimée ; au plafond, elle est GARDÉE.
      assertThat(count("SELECT count(*) FROM attempt")).isEqualTo(failure < 3 ? 0L : 1L);
      TestTransaction.end();
    }
    Integer reviewId = attemptId;

    TestTransaction.start();
    assertThat(count("SELECT count(*) FROM attempt WHERE status = 'review'")).isEqualTo(1L);
    // L'étudiant la voit dans son historique, sans note ni corrigé ; et sa tentative unique est
    // consommée.
    assertThat(quizService.getMyAttempts(quizId, USER_EMAIL))
        .singleElement()
        .satisfies(a -> {
          assertThat(a.getStatus()).isEqualTo(QuizService.REVIEW);
          assertThat(a.getEarned()).isNull();
        });
    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> quizService.getAttemptResult(reviewId, USER_EMAIL))
        .isInstanceOf(com.moodit.core_service.exception.AttemptNotFoundException.class);
    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> quizService.submitQuiz(quizId, submissionWithCode("print(2)"), USER_EMAIL))
        .isInstanceOf(com.moodit.core_service.exception.AlreadySubmittedException.class);
    // L'enseignant la retrouve, avec le compte des échecs.
    assertThat(quizService.getAttemptsToReview(quizId))
        .singleElement()
        .satisfies(r -> {
          assertThat(r.attemptId()).isEqualTo(reviewId);
          assertThat(r.noVerdictFailures()).isEqualTo(3);
          assertThat(r.studentName()).isEqualTo("Éva Test");
        });
    TestTransaction.end();

    // Relance par l'enseignant, puis correction qui aboutit.
    // doReturn : un when(...) rappellerait la méthode, encore stubbée pour lever.
    org.mockito.Mockito.doReturn(List.of(true))
        .when(executionClient).evaluate(any(), any(), any(), any(), any());
    quizService.regradeAttempt(quizId, reviewId);
    TestTransaction.start();
    assertThat(count("SELECT count(*) FROM attempt WHERE status = 'pending'")).isEqualTo(1L);
    assertThat(count("SELECT count(*) FROM audit_log WHERE action = 'QUIZ_REGRADE'")).isEqualTo(1L);
    TestTransaction.end();

    quizService.gradeAttempt(reviewId);

    TestTransaction.start();
    assertThat(count("SELECT count(*) FROM attempt WHERE status = 'done'")).isEqualTo(1L);
    assertThat(count("SELECT count(*) FROM grading_failure")).isZero();
    assertThat(quizService.getAttemptResult(reviewId, USER_EMAIL).getEarned()).isEqualTo(10.0);
    assertThat(quizService.getAttemptsToReview(quizId)).isEmpty();
    TestTransaction.end();
  }

  @Test
  @DisplayName("Relance (#116, S4) : à revoir pendant la relance, et de retour à revoir si elle échoue, même compte remis à zéro")
  void regradeThatFails_comesBackToReview_evenAfterTheCountWasReset() {
    // Quiz AVEC reprise : une autre tentative corrigée entre-temps remet le compte à zéro.
    em.getEntityManager().createNativeQuery("UPDATE quiz SET allow_retry = TRUE").executeUpdate();
    when(executionClient.evaluate(any(), any(), any(), any(), any()))
        .thenThrow(new com.moodit.core_service.exception.CodeVerificationNoVerdictException());
    TestTransaction.flagForCommit();
    TestTransaction.end();
    committed = true;

    Integer reviewId = null;
    for (int failure = 1; failure <= 3; failure++) {
      TestTransaction.start();
      reviewId = quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL);
      TestTransaction.flagForCommit();
      TestTransaction.end();
      quizService.gradeAttempt(reviewId);
    }
    Integer regradedId = reviewId;

    // Nouvelle tentative, corrigée normalement : le compte d'échecs repart de zéro.
    org.mockito.Mockito.doReturn(List.of(true))
        .when(executionClient).evaluate(any(), any(), any(), any(), any());
    TestTransaction.start();
    Integer gradedId = quizService.submitQuiz(quizId, submissionWithCode("print(2)"), USER_EMAIL);
    TestTransaction.flagForCommit();
    TestTransaction.end();
    quizService.gradeAttempt(gradedId);
    TestTransaction.start();
    assertThat(count("SELECT count(*) FROM grading_failure")).isZero();
    TestTransaction.end();

    // Relance : pendant la correction, l'étudiant voit toujours la tentative à revoir.
    quizService.regradeAttempt(quizId, regradedId);
    TestTransaction.start();
    assertThat(quizService.getMyAttempts(quizId, USER_EMAIL))
        .extracting(a -> a.getId(), a -> a.getStatus(), a -> a.getEarned())
        .containsExactly(
            org.assertj.core.groups.Tuple.tuple(regradedId, QuizService.REVIEW, null),
            org.assertj.core.groups.Tuple.tuple(gradedId, "done", 10.0));
    TestTransaction.end();

    // La relance échoue (sandbox indisponible) : la tentative revient à revoir, elle n'est pas
    // supprimée.
    org.mockito.Mockito.doReturn(null)
        .when(executionClient).evaluate(any(), any(), any(), any(), any());
    quizService.gradeAttempt(regradedId);
    TestTransaction.start();
    assertThat(count("SELECT count(*) FROM attempt WHERE status = 'review'")).isEqualTo(1L);
    assertThat(quizService.getAttemptsToReview(quizId))
        .singleElement()
        .satisfies(r -> assertThat(r.attemptId()).isEqualTo(regradedId));
    TestTransaction.end();

    // Seconde relance, qui aboutit : notée, et le marqueur de relance retombe.
    org.mockito.Mockito.doReturn(List.of(true))
        .when(executionClient).evaluate(any(), any(), any(), any(), any());
    quizService.regradeAttempt(quizId, regradedId);
    quizService.gradeAttempt(regradedId);
    TestTransaction.start();
    assertThat(count("SELECT count(*) FROM attempt WHERE status = 'done'")).isEqualTo(2L);
    assertThat(count("SELECT count(*) FROM attempt WHERE regrade = TRUE")).isZero();
    assertThat(quizService.getAttemptResult(regradedId, USER_EMAIL).getEarned()).isEqualTo(10.0);
    TestTransaction.end();
  }

  @Test
  @DisplayName("Deux soumissions de suite, quiz sans reprise : la 2e est refusée « en cours », pas « déjà soumis »")
  void secondSubmissionWhileGrading_noRetry_isInProgress() {
    Integer firstId = quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL);

    // Le pending de la 1re compte aussi parmi les tentatives : sans la vérification préalable,
    // ce serait le 409 « déjà soumis », et le frontend ne rejoindrait pas l'attente. Le 409
    // porte l'id de la 1re : le client attend CETTE tentative.
    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> quizService.submitQuiz(quizId, submissionWithCode("print(2)"), USER_EMAIL))
        .isInstanceOf(com.moodit.core_service.exception.GradingInProgressException.class)
        .extracting(e -> ((com.moodit.core_service.exception.GradingInProgressException) e).getAttemptId())
        .isEqualTo(firstId);
    assertThat(count("SELECT count(*) FROM attempt")).isEqualTo(1L);
  }

  @Test
  @DisplayName("Deux soumissions de suite, quiz AVEC reprise : la 2e est refusée « en cours », avec l'id du pending, aucune tentative de plus")
  void secondSubmissionWhileGrading_withRetry_isInProgress() {
    em.getEntityManager().createNativeQuery("UPDATE quiz SET allow_retry = TRUE").executeUpdate();
    // Une tentative déjà corrigée avant (la reprise laisse passer le comptage) : le pending
    // est la n° 2. Pas un cas discriminant entre « pending » et « dernière tentative » : dans
    // le modèle, le pending d'une soumission est toujours la dernière (seule une relance, qui
    // répond « relance », est un pending plus ancien) ; ce filtre est épinglé par les tests
    // unitaires de QuizServiceSubmissionTest.
    persistAttempt(em.find(Quiz.class, quizId), em.getEntityManager()
        .createQuery("SELECT u FROM User u WHERE u.email = :email", User.class)
        .setParameter("email", USER_EMAIL).getSingleResult(), 1, "done");
    em.flush();
    em.clear();
    Integer pendingId = quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL);

    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> quizService.submitQuiz(quizId, submissionWithCode("print(2)"), USER_EMAIL))
        .isInstanceOf(com.moodit.core_service.exception.GradingInProgressException.class)
        .extracting(e -> ((com.moodit.core_service.exception.GradingInProgressException) e).getAttemptId())
        .isEqualTo(pendingId);
    assertThat(count("SELECT count(*) FROM attempt")).isEqualTo(2L);
  }

  @Test
  @DisplayName("Trou de numérotation (tentatives 1 et 3) : la soumission suivante prend le n° 4, sans collision")
  void attemptNumberingGap_nextSubmissionTakesMaxPlusOne() {
    // Une tentative supprimée (correction échouée) laisse un trou : numéroter sur le comptage
    // (2 + 1 = 3) heurtait UNIQUE(quiz,user,attempt_no) à chaque soumission suivante. Lu ici par
    // la VRAIE requête d'agrégats du contrôle préalable (comptage, plus grand n°, pending).
    em.getEntityManager().createNativeQuery("UPDATE quiz SET allow_retry = TRUE").executeUpdate();
    Quiz quiz = em.find(Quiz.class, quizId);
    User user = em.getEntityManager()
        .createQuery("SELECT u FROM User u WHERE u.email = :email", User.class)
        .setParameter("email", USER_EMAIL).getSingleResult();
    persistAttempt(quiz, user, 1, "done");
    persistAttempt(quiz, user, 3, "done");
    em.flush();
    em.clear();

    Integer newId = quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL);

    assertThat(attemptRepository.findById(newId)).get()
        .satisfies(a -> {
          assertThat(a.getAttemptNo()).isEqualTo(4);
          assertThat(a.getStatus()).isEqualTo("pending");
        });
    assertThat(count("SELECT count(*) FROM attempt")).isEqualTo(3L);
  }

  @Test
  @DisplayName("Soumission pendant une RELANCE de l'enseignant, quiz AVEC reprise : refusée « relance », pas « en cours »")
  void submissionDuringTeacherRegrade_withRetry_isRegradeInProgress() {
    em.getEntityManager().createNativeQuery("UPDATE quiz SET allow_retry = TRUE").executeUpdate();
    regradeAReviewAttempt();

    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> quizService.submitQuiz(quizId, submissionWithCode("print(2)"), USER_EMAIL))
        .isInstanceOf(com.moodit.core_service.exception.RegradeInProgressException.class);
    assertThat(count("SELECT count(*) FROM attempt")).isEqualTo(1L);
  }

  @Test
  @DisplayName("Soumission pendant une RELANCE de l'enseignant, quiz SANS reprise : « déjà soumis » (la relance porte sur la tentative unique)")
  void submissionDuringTeacherRegrade_noRetry_isAlreadySubmitted() {
    regradeAReviewAttempt();

    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> quizService.submitQuiz(quizId, submissionWithCode("print(2)"), USER_EMAIL))
        .isInstanceOf(com.moodit.core_service.exception.AlreadySubmittedException.class);
    assertThat(count("SELECT count(*) FROM attempt")).isEqualTo(1L);
  }

  /**
   * Tentative « à revoir » de l'étudiant, relancée par l'enseignant : elle repasse pending avec le
   * marqueur de relance, que la requête dérivée du dépôt lit vraiment ensuite.
   */
  private void regradeAReviewAttempt() {
    Attempt review = new Attempt();
    review.setQuiz(em.find(Quiz.class, quizId));
    review.setUser(em.getEntityManager()
        .createQuery("SELECT u FROM User u WHERE u.email = :email", User.class)
        .setParameter("email", USER_EMAIL).getSingleResult());
    review.setAttemptNo(1);
    review.setStatus(QuizService.REVIEW);
    review.setSubmittedAt(LocalDateTime.now());
    em.persist(review);
    em.flush();
    quizService.regradeAttempt(quizId, review.getId());
    em.flush();
    em.clear();
    assertThat(count("SELECT count(*) FROM attempt WHERE status = 'pending' AND regrade = TRUE"))
        .isEqualTo(1L);
  }

  @Test
  @DisplayName("Compteur « à revoir » de l'éditeur : tentatives review du cours, par quiz, sur une vraie base")
  void reviewCounter_countsReviewAttemptsOfTheCourseOnly() {
    // La requête JPQL (AttemptRepository.countByStatusPerQuiz) n'est que mockée dans les tests
    // unitaires : ici, son filtre par cours, son filtre par statut et son regroupement par quiz
    // tournent vraiment. Interrogée DIRECTEMENT : listQuizzes ne lit que les quiz du cours, et
    // ne verrait pas une ligne d'un autre cours qu'un filtre perdu laisserait passer.
    Quiz quiz = em.find(Quiz.class, quizId);
    User user = em.getEntityManager()
        .createQuery("SELECT u FROM User u WHERE u.email = :email", User.class)
        .setParameter("email", USER_EMAIL).getSingleResult();
    // Deux quiz du MÊME cours aux comptes différents (2 et 1) : un regroupement par cours
    // donnerait une seule ligne à 3.
    Quiz sibling = Quiz.builder()
        .title("Quiz voisin").isDaily(false).isPublished(true).allowRetry(true)
        .position(1).createdAt(LocalDateTime.now()).course(quiz.getCourse()).build();
    em.persist(sibling);
    Course other = Course.builder().title("Autre cours").code("C2").build();
    em.persist(other);
    Quiz otherQuiz = Quiz.builder()
        .title("Autre quiz").isDaily(false).isPublished(true).allowRetry(true)
        .position(0).createdAt(LocalDateTime.now()).course(other).build();
    em.persist(otherQuiz);
    persistAttempt(quiz, user, 1, QuizService.REVIEW);
    persistAttempt(quiz, user, 2, QuizService.REVIEW);
    persistAttempt(quiz, user, 3, "done");
    persistAttempt(sibling, user, 1, QuizService.REVIEW);
    persistAttempt(otherQuiz, user, 1, QuizService.REVIEW);
    Integer courseId = quiz.getCourse().getId();
    Integer siblingId = sibling.getId();
    Integer otherQuizId = otherQuiz.getId();
    Integer otherCourseId = other.getId();
    em.flush();
    em.clear();

    assertThat(attemptRepository.countByStatusPerQuiz(courseId, QuizService.REVIEW))
        .extracting(row -> List.of(((Number) row[0]).intValue(), ((Number) row[1]).intValue()))
        .containsExactlyInAnyOrder(List.of(quizId, 2), List.of(siblingId, 1));
    assertThat(attemptRepository.countByStatusPerQuiz(otherCourseId, QuizService.REVIEW))
        .extracting(row -> List.of(((Number) row[0]).intValue(), ((Number) row[1]).intValue()))
        .containsExactly(List.of(otherQuizId, 1));
    // Et le compteur tel que l'éditeur le reçoit.
    assertThat(quizService.listQuizzes(courseId, false))
        .extracting(QuizDTO::getReviewAttemptCount)
        .containsExactly(2, 1);
  }

  private void persistAttempt(Quiz quiz, User user, int attemptNo, String status) {
    Attempt attempt = new Attempt();
    attempt.setQuiz(quiz);
    attempt.setUser(user);
    attempt.setAttemptNo(attemptNo);
    attempt.setStatus(status);
    attempt.setSubmittedAt(LocalDateTime.now());
    em.persist(attempt);
  }

  /** Purge les données committées (base H2 partagée par les tests de la classe). */
  @AfterEach
  void purgeCommitted() {
    if (!committed) {
      return;
    }
    if (!TestTransaction.isActive()) {
      TestTransaction.start();
    }
    for (String table : List.of("audit_log", "grading_failure", "submission_test_case", "submission", "attempt", "test_case",
        "question", "quiz", "language", "q_type", "user_", "course")) {
      em.getEntityManager().createNativeQuery("DELETE FROM " + table).executeUpdate();
    }
    TestTransaction.flagForCommit();
    TestTransaction.end();
  }

  private QuizSubmissionDTO submissionWithCode(String code) {
    return QuizSubmissionDTO.builder()
        .quizId(quizId)
        .answers(List.of(SubmittedAnswerDTO.builder().questionId(questionId).code(code).build()))
        .build();
  }

  private long count(String sql) {
    return ((Number) em.getEntityManager().createNativeQuery(sql).getSingleResult()).longValue();
  }
}
