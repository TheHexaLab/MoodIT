package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.QuestionResultDTO;
import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.dto.SubmittedAnswerDTO;
import com.moodit.core_service.exception.CodeVerificationUnavailableException;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Language;
import com.moodit.core_service.model.QType;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.TestCase;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import java.time.LocalDateTime;
import java.util.List;
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

/**
 * Test d'intégration de {@link QuizService#submitQuiz} sur H2 (schéma généré depuis les entités),
 * ciblant la vérification SYNCHRONE des questions Code au moment de la soumission :
 *   1. exécution indisponible → 503 ({@link CodeVerificationUnavailableException}) et AUCUNE
 *      tentative/soumission enregistrée (l'étudiant peut renvoyer sans consommer sa tentative) ;
 *   2. exécution réussie → tentative + verdicts persistés et question Code notée.
 * {@link ExecutionClient} est mocké (pas de sandbox Piston dans un test).
 */
@DataJpaTest
@Import(QuizService.class)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:moodit_submit_it;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE;NON_KEYWORDS=ROLE,USER,VALUE,LANGUAGE,POSITION",
      "spring.datasource.driver-class-name=org.h2.Driver",
      "spring.datasource.username=sa",
      "spring.datasource.password=",
      "spring.jpa.hibernate.ddl-auto=create-drop"
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

  // Dépendances hors périmètre JPA : mockées.
  @MockitoBean private RealtimeEventPublisher realtimePublisher;
  @MockitoBean private ExecutionClient executionClient;

  private static final String USER_EMAIL = "eva@test.ca";
  private Integer quizId;
  private Integer questionId;

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
  @DisplayName("Exécution indisponible → 503 et AUCUNE tentative persistée (renvoi possible)")
  void submit_whenExecutionUnavailable_throwsAndPersistsNothing() {
    // Sandbox injoignable → l'ExecutionClient renvoie null.
    when(executionClient.evaluate(any(), any(), any())).thenReturn(null);

    assertThatThrownBy(
            () -> quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL))
        .isInstanceOf(CodeVerificationUnavailableException.class);

    em.flush();
    em.clear();
    // Rien n'a été écrit : la tentative unique n'est pas consommée.
    assertThat(count("SELECT count(*) FROM attempt")).isZero();
    assertThat(count("SELECT count(*) FROM submission")).isZero();
    assertThat(count("SELECT count(*) FROM submission_test_case")).isZero();
  }

  @Test
  @DisplayName("Exécution réussie → tentative + verdicts persistés et question Code notée")
  void submit_whenExecutionSucceeds_persistsAttemptAndVerdicts() {
    // Le harnais unique passe.
    when(executionClient.evaluate(any(), any(), any())).thenReturn(List.of(true));

    QuizResultDTO result = quizService.submitQuiz(quizId, submissionWithCode("print(1)"), USER_EMAIL);

    assertThat(result.getAttemptId()).isNotNull();
    QuestionResultDTO codeResult = result.getQuestions().stream()
        .filter(q -> q.getQuestionId().equals(questionId))
        .findFirst()
        .orElseThrow();
    // tests non-null (plus de « en cours ») + score plein (harnais réussi sur barème 10).
    assertThat(codeResult.getTests()).isNotNull().hasSize(1);
    assertThat(codeResult.getEarned()).isEqualTo(10.0);

    em.flush();
    em.clear();
    assertThat(count("SELECT count(*) FROM attempt")).isEqualTo(1L);
    assertThat(count("SELECT count(*) FROM submission")).isEqualTo(1L);
    assertThat(count("SELECT count(*) FROM submission_test_case WHERE passed = TRUE")).isEqualTo(1L);
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
