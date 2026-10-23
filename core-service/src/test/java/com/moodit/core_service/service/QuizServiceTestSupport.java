package com.moodit.core_service.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.SubmittedAnswerDTO;
import com.moodit.core_service.model.Answer;
import com.moodit.core_service.model.Attempt;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.DragItem;
import com.moodit.core_service.model.Language;
import com.moodit.core_service.model.Program;
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
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Socle commun des tests unitaires de {@link QuizService} : toutes les dépendances sont mockées
 * (le {@link PlatformTransactionManager} mocké suffit aux {@code TransactionTemplate} internes :
 * getTransaction/commit ne font rien), l'ObjectMapper est RÉEL (sérialisation des réponses), et des
 * fabriques d'entités rendent les scénarios lisibles. Hors synchronisation transactionnelle active,
 * les diffusions « après commit » partent immédiatement : on peut donc les vérifier directement.
 */
@ExtendWith(MockitoExtension.class)
abstract class QuizServiceTestSupport {

    // Libellés Q_Type en base (cf. Q_TYPE_NAME_TO_SLUG de QuizService).
    static final String TRUE_FALSE = "Vrai/Faux";
    static final String SINGLE = "Choix unique";
    static final String MULTIPLE = "Choix multiple";
    static final String ORDERING = "Remise en ordre";
    static final String MATCHING = "Association";
    static final String CODE = "Code";

    static final String EMAIL = "eva@test.ca";

    @Mock QuizRepository quizRepository;
    @Mock CourseRepository courseRepository;
    @Mock QTypeRepository qTypeRepository;
    @Mock LanguageRepository languageRepository;
    @Mock SubmissionRepository submissionRepository;
    @Mock SubmissionTestCaseRepository submissionTestCaseRepository;
    @Mock AttemptRepository attemptRepository;
    @Mock UserRepository userRepository;
    @Mock RealtimeEventPublisher realtimePublisher;
    @Mock ExecutionClient executionClient;
    @Mock PlatformTransactionManager transactionManager;
    @Mock ApplicationEventPublisher eventPublisher;
    @Mock AuditLogService auditLogService;

    final ObjectMapper objectMapper = new ObjectMapper();
    QuizService service;

    @BeforeEach
    void createService() {
        service = new QuizService(
                quizRepository, courseRepository, qTypeRepository, languageRepository,
                submissionRepository, submissionTestCaseRepository, attemptRepository, userRepository,
                objectMapper, realtimePublisher, executionClient, transactionManager, eventPublisher,
                auditLogService);
    }

    // ── Fabriques d'entités ─────────────────────────────────────────────────────

    static QType type(int id, String name) {
        return QType.builder().id(id).name(name).build();
    }

    /** Question vide (listes mutables) du type donné ; {@code typeName} null = type absent. */
    static Question question(int id, String typeName, double score, int orderIndex) {
        Question q = new Question();
        q.setId(id);
        q.setPrompt("Question " + id);
        q.setQType(typeName == null ? null : type(id * 100, typeName));
        q.setTotalScore(score);
        q.setOrderIndex(orderIndex);
        q.setAnswers(new ArrayList<>());
        q.setDragItems(new ArrayList<>());
        q.setTestCases(new ArrayList<>());
        return q;
    }

    static Answer answer(Question q, int id, String content, boolean correct) {
        Answer a = new Answer();
        a.setId(id);
        a.setContent(content);
        a.setIsCorrect(correct);
        a.setQuestion(q);
        q.getAnswers().add(a);
        return a;
    }

    static DragItem drag(Question q, int id, String content, Integer correctOrder, String group) {
        DragItem d = new DragItem();
        d.setId(id);
        d.setContent(content);
        d.setCorrectOrder(correctOrder);
        d.setGroupName(group);
        d.setQuestion(q);
        q.getDragItems().add(d);
        return d;
    }

    static TestCase testCase(Question q, int id, String name, Integer weight) {
        TestCase tc = new TestCase();
        tc.setId(id);
        tc.setName(name);
        tc.setHarnessCode("assert " + name);
        tc.setWeight(weight);
        tc.setQuestion(q);
        q.getTestCases().add(tc);
        return tc;
    }

    static Language language(int id, String name) {
        Language l = new Language();
        l.setId(id);
        l.setName(name);
        l.setHarnessTemplate("harness-" + name);
        l.setStartCodeTemplate("start-" + name);
        l.setHarnessLanguageId(id + 1000);
        return l;
    }

    static Program program(int id, String name) {
        return Program.builder().id(id).name(name).code("P" + id).cohort("2026").build();
    }

    /** Cours rattaché aux programmes donnés (liste de quiz vide et mutable). */
    static Course course(int id, Program... programs) {
        return Course.builder()
                .id(id).title("Algo").code("IFT" + id)
                .quizzes(new ArrayList<>())
                .programs(new ArrayList<>(Arrays.asList(programs)))
                .build();
    }

    static Quiz quiz(int id, Course course, Question... questions) {
        Quiz quiz = Quiz.builder()
                .id(id).title("Quiz " + id)
                .isDaily(false).isPublished(true).allowRetry(false)
                .position(0).createdAt(LocalDateTime.of(2026, 9, 1, 10, 0))
                .course(course)
                .questions(new ArrayList<>(Arrays.asList(questions)))
                .build();
        for (Question q : questions) {
            q.setQuiz(quiz);
        }
        return quiz;
    }

    static User user(int id, String email) {
        return User.builder().id(id).username("u" + id).firstName("Éva").lastName("Test")
                .email(email).passwordHash("hash").build();
    }

    /** Soumission dont le contenu est la réponse sérialisée (comme persistPendingAttempt). */
    Submission submission(Question q, SubmittedAnswerDTO answer) {
        Submission s = new Submission();
        s.setQuestion(q);
        try {
            s.setContent(answer == null ? null : objectMapper.writeValueAsString(answer));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
        s.setTestCaseResults(new ArrayList<>());
        return s;
    }

    /** Ajoute un verdict persisté (Submission_Test_Case) à une soumission. */
    static void verdict(Submission s, TestCase tc, boolean passed) {
        SubmissionTestCase v = new SubmissionTestCase();
        v.setSubmission(s);
        v.setTestCase(tc);
        v.setPassed(passed);
        s.getTestCaseResults().add(v);
    }

    static Attempt attempt(int id, Quiz quiz, User user, int no, String status, Submission... subs) {
        Attempt a = new Attempt();
        a.setId(id);
        a.setQuiz(quiz);
        a.setUser(user);
        a.setAttemptNo(no);
        a.setStatus(status);
        a.setSubmissions(new ArrayList<>(Arrays.asList(subs)));
        for (Submission s : subs) {
            s.setAttempt(a);
            s.setUser(user);
        }
        return a;
    }

    static SubmittedAnswerDTO choice(int questionId, Integer... answerIds) {
        return SubmittedAnswerDTO.builder().questionId(questionId).answerIds(List.of(answerIds)).build();
    }
}
