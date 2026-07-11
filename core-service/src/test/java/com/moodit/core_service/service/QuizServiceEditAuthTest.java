package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.exception.ForbiddenException;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.Role;
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
import org.springframework.transaction.PlatformTransactionManager;
import java.util.Arrays;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * Autorisation de l'ÉDITEUR de quiz ({@link QuizService#getQuizForEdit}) : le quiz est résolu
 * AVANT le contrôle (il fournit le courseId), et l'accès est refusé (403) à qui n'a ni rôle
 * global admin/gardien ni rôle programme admin/enseignant du cours. Les cas AUTORISÉS
 * (qui poursuivent vers la sérialisation complète) sont couverts par le test d'intégration live.
 */
@ExtendWith(MockitoExtension.class)
class QuizServiceEditAuthTest {

    @Mock private QuizRepository quizRepository;
    @Mock private CourseRepository courseRepository;
    @Mock private QTypeRepository qTypeRepository;
    @Mock private LanguageRepository languageRepository;
    @Mock private SubmissionRepository submissionRepository;
    @Mock private SubmissionTestCaseRepository submissionTestCaseRepository;
    @Mock private AttemptRepository attemptRepository;
    @Mock private UserRepository userRepository;
    @Mock private RealtimeEventPublisher realtimePublisher;
    @Mock private ExecutionClient executionClient;
    @Mock private PlatformTransactionManager transactionManager;

    private QuizService service;

    @BeforeEach
    void setUp() {
        service = new QuizService(
                quizRepository, courseRepository, qTypeRepository, languageRepository,
                submissionRepository, submissionTestCaseRepository, attemptRepository, userRepository,
                new ObjectMapper(), realtimePublisher, executionClient, transactionManager);
    }

    private static User userWith(String... roleNames) {
        User u = new User();
        u.setId(5);
        u.setEmail("a@a");
        u.setRoles(Arrays.stream(roleNames).map(n -> {
            Role r = new Role();
            r.setName(n);
            return r;
        }).toList());
        return u;
    }

    private static Quiz quizInCourse(int courseId) {
        Course c = new Course();
        c.setId(courseId);
        Quiz q = new Quiz();
        q.setCourse(c);
        return q;
    }

    @Test
    void getQuizForEdit_missingQuiz_throwsNotFound() {
        // Le quiz est cherché AVANT l'autorisation (il donne le courseId) : absent → 404.
        when(quizRepository.findById(999)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getQuizForEdit(999, "a@a"))
                .isInstanceOf(QuizNotFoundException.class);
    }

    @Test
    void getQuizForEdit_noGlobalNorProgramRole_isForbidden() {
        when(quizRepository.findById(1)).thenReturn(Optional.of(quizInCourse(10)));
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(userWith("Etudiant")));
        when(userRepository.hasProgramTeachingRoleForCourse(5, 10)).thenReturn(false);

        assertThatThrownBy(() -> service.getQuizForEdit(1, "a@a"))
                .isInstanceOf(ForbiddenException.class);
    }

    // ── listQuizzes : la vue ÉDITEUR (brouillons) est protégée, la vue ÉTUDIANT (publiés) ouverte ──

    @Test
    void listQuizzes_draftsMode_noRole_isForbidden() {
        // published=false → brouillons compris → contrôle d'accès (403 avant même de lire le cours).
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(userWith("Etudiant")));
        when(userRepository.hasProgramTeachingRoleForCourse(5, 10)).thenReturn(false);

        assertThatThrownBy(() -> service.listQuizzes(10, false, "a@a"))
                .isInstanceOf(ForbiddenException.class);
    }

    @Test
    void listQuizzes_publishedMode_isOpenToAnyMember() {
        // published=true → vue étudiant → AUCUN contrôle (findByEmail n'est même pas appelé).
        Course c = new Course();
        c.setId(10);
        when(courseRepository.findById(10)).thenReturn(Optional.of(c));

        assertThat(service.listQuizzes(10, true, "student@a")).isEmpty();
    }
}
