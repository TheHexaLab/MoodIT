package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.CourseQuizStatsDTO;
import com.moodit.core_service.dto.SubmittedAnswerDTO;
import com.moodit.core_service.model.Answer;
import com.moodit.core_service.model.Attempt;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.QType;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.Submission;
import com.moodit.core_service.model.SubmissionTestCase;
import com.moodit.core_service.model.TestCase;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.AttemptRepository;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.LanguageRepository;
import com.moodit.core_service.repository.QTypeRepository;
import com.moodit.core_service.repository.QuizRepository;
import com.moodit.core_service.repository.SubmissionRepository;
import com.moodit.core_service.repository.SubmissionTestCaseRepository;
import com.moodit.core_service.repository.UserRepository;
import jakarta.persistence.EntityManagerFactory;
import java.time.LocalDateTime;
import java.util.List;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Test ANTI-N+1 de {@link QuizService#getCourseQuizStats} (#30) : tentatives, soumissions et
 * verdicts de tests sont chargés par requêtes groupées. Le nombre de requêtes SQL doit être le
 * même pour 10 et pour 200 tentatives (un étudiant distinct par tentative). Avant, chaque
 * tentative coûtait une requête pour ses soumissions, puis une par soumission pour ses verdicts.
 *
 * <p>Comptage par les statistiques Hibernate, comme {@link ForumServiceN1Test}.
 */
@DataJpaTest
class QuizServiceStatsQueryCountTest {

  @Autowired private AttemptRepository attemptRepository;
  @Autowired private SubmissionRepository submissionRepository;
  @Autowired private UserRepository userRepository;
  @Autowired private TestEntityManager em;
  @Autowired private EntityManagerFactory emf;

  private final ObjectMapper objectMapper = new ObjectMapper();
  private QuizService quizService;
  private QType single;
  private QType code;
  private int userSeq;

  @BeforeEach
  void setUp() {
    quizService =
        new QuizService(
            mock(QuizRepository.class),
            mock(CourseRepository.class),
            mock(QTypeRepository.class),
            mock(LanguageRepository.class),
            submissionRepository,
            mock(SubmissionTestCaseRepository.class),
            attemptRepository,
            userRepository,
            objectMapper,
            mock(RealtimeEventPublisher.class),
            mock(ExecutionClient.class),
            mock(PlatformTransactionManager.class),
            mock(ApplicationEventPublisher.class),
            mock(AuditLogService.class),
            mock(QuizItemObfuscator.class));

    single = new QType();
    single.setName("Choix unique");
    em.persist(single);
    code = new QType();
    code.setName("Code");
    em.persist(code);
  }

  /**
   * Cours avec un quiz (une question à choix unique sur 2 points + une question Code), et
   * {@code attempts} tentatives « done » d'étudiants distincts : une sur deux répond juste. Chaque
   * tentative a sa soumission Code avec un verdict persisté. Une tentative « pending » en plus.
   */
  private Integer seed(int attempts) throws Exception {
    Course course = new Course();
    course.setTitle("Cours " + attempts);
    course.setCode("Q" + attempts);
    em.persist(course);

    Quiz quiz = new Quiz();
    quiz.setTitle("Quiz");
    quiz.setIsDaily(false);
    quiz.setIsPublished(true);
    quiz.setAllowRetry(false);
    quiz.setPosition(0);
    quiz.setCreatedAt(LocalDateTime.of(2026, 9, 1, 10, 0));
    quiz.setCourse(course);
    em.persist(quiz);

    Question choiceQ = question(quiz, single, 2.0, 0);
    Answer right = answer(choiceQ, "ok", true);
    Answer wrong = answer(choiceQ, "ko", false);
    Question codeQ = question(quiz, code, 8.0, 1);
    TestCase harness = new TestCase();
    harness.setName("t1");
    harness.setHarnessCode("assert t1");
    harness.setWeight(1);
    harness.setQuestion(codeQ);
    em.persist(harness);

    for (int i = 0; i <= attempts; i++) {
      User student = newUser();
      Attempt attempt = new Attempt();
      attempt.setQuiz(quiz);
      attempt.setUser(student);
      attempt.setAttemptNo(1);
      attempt.setStatus(i < attempts ? "done" : "pending");
      em.persist(attempt);

      Answer chosen = i % 2 == 0 ? right : wrong;
      submission(attempt, student, choiceQ, SubmittedAnswerDTO.builder()
          .questionId(choiceQ.getId()).answerIds(List.of(chosen.getId())).build());
      Submission codeSub = submission(attempt, student, codeQ, SubmittedAnswerDTO.builder()
          .questionId(codeQ.getId()).code("print(1)").build());
      SubmissionTestCase verdict = new SubmissionTestCase();
      verdict.setSubmission(codeSub);
      verdict.setTestCase(harness);
      verdict.setPassed(true);
      em.persist(verdict);
    }

    em.flush();
    em.clear();
    return course.getId();
  }

  private User newUser() {
    int i = userSeq++;
    User u = new User();
    u.setUsername("etu" + i);
    u.setFirstName("Prenom" + i);
    u.setLastName("Nom" + i);
    u.setEmail("etu" + i + "@test.ca");
    u.setPasswordHash("hash");
    em.persist(u);
    return u;
  }

  private Question question(Quiz quiz, QType type, double score, int order) {
    Question q = new Question();
    q.setPrompt("Question " + order);
    q.setQType(type);
    q.setTotalScore(score);
    q.setOrderIndex(order);
    q.setQuiz(quiz);
    em.persist(q);
    return q;
  }

  private Answer answer(Question q, String content, boolean correct) {
    Answer a = new Answer();
    a.setContent(content);
    a.setIsCorrect(correct);
    a.setQuestion(q);
    em.persist(a);
    return a;
  }

  private Submission submission(Attempt attempt, User user, Question q, SubmittedAnswerDTO answer)
      throws Exception {
    Submission s = new Submission();
    s.setAttempt(attempt);
    s.setUser(user);
    s.setQuestion(q);
    s.setContent(objectMapper.writeValueAsString(answer));
    em.persist(s);
    return s;
  }

  /** Requêtes exécutées par getCourseQuizStats, contexte de persistance vide au départ. */
  private long queriesFor(Integer courseId, int attempts) {
    Statistics stats = emf.unwrap(SessionFactory.class).getStatistics();
    stats.setStatisticsEnabled(true);
    em.clear();
    stats.clear();

    CourseQuizStatsDTO result = quizService.getCourseQuizStats(courseId);

    // Résultat inchangé : une tentative sur deux à 100 %, l'autre à 0 % ; Code exclu ; pending
    // ignorée.
    assertThat(result.averageScorePercent()).isEqualTo(50);
    assertThat(result.gradedAttemptCount()).isEqualTo(attempts);
    assertThat(result.studentCount()).isEqualTo(attempts);
    return stats.getPrepareStatementCount();
  }

  @Test
  void getCourseQuizStats_nombreDeRequetes_neDependPasDuNombreDeTentatives() throws Exception {
    long q10 = queriesFor(seed(10), 10);
    long q200 = queriesFor(seed(200), 200);
    System.out.printf("[#30] getCourseQuizStats : 10 tentatives → %d requêtes ; 200 → %d%n", q10, q200);

    assertThat(q200).isEqualTo(q10);
    assertThat(q200).isLessThan(12);
  }

  @Test
  void getCourseQuizStats_coursSansTentative() {
    Course empty = new Course();
    empty.setTitle("Vide");
    empty.setCode("VIDE");
    em.persist(empty);
    em.flush();
    em.clear();

    CourseQuizStatsDTO result = quizService.getCourseQuizStats(empty.getId());

    assertThat(result.averageScorePercent()).isNull();
    assertThat(result.gradedAttemptCount()).isZero();
    assertThat(result.studentCount()).isZero();
  }
}
