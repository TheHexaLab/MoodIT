package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.AttemptRepository;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.LanguageRepository;
import com.moodit.core_service.repository.QTypeRepository;
import com.moodit.core_service.repository.QuizRepository;
import com.moodit.core_service.repository.SubmissionRepository;
import com.moodit.core_service.repository.SubmissionTestCaseRepository;
import com.moodit.core_service.repository.UserRepository;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.transaction.PlatformTransactionManager;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * Comportement de lecture des quiz par QuizService. QuizService ne fait PLUS AUCUN contrôle
 * d'accès par rôle : tout est délégué au permission-service (règles /api/quizzes, /api/courses,
 * dont GET /courses/{id}/quizzes/manage pour la vue éditeur/brouillons). On vérifie ici la
 * résolution des ressources (404) et le filtrage publiés/brouillons de listQuizzes.
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
    @Mock private ApplicationEventPublisher eventPublisher;

    private QuizService service;

    @BeforeEach
    void setUp() {
        service = new QuizService(
                quizRepository, courseRepository, qTypeRepository, languageRepository,
                submissionRepository, submissionTestCaseRepository, attemptRepository, userRepository,
                new ObjectMapper(), realtimePublisher, executionClient, transactionManager, eventPublisher);
    }

    @Test
    void getQuizForEdit_missingQuiz_throwsNotFound() {
        // Quiz absent → 404 (l'autorisation par rôle est faite en amont par le gateway).
        when(quizRepository.findById(999)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getQuizForEdit(999))
                .isInstanceOf(QuizNotFoundException.class);
    }

    @Test
    void listQuizzes_missingCourse_throwsNotFound() {
        // Cours absent → 404 (l'autorisation est faite en amont : route /manage gatée par le gateway).
        when(courseRepository.findById(10)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.listQuizzes(10, false))
                .isInstanceOf(com.moodit.core_service.exception.CourseNotFoundException.class);
    }

    @Test
    void listQuizzes_returnsMetaList() {
        // Aucun contrôle de rôle : le service se contente de projeter (ici cours sans quiz → vide).
        Course c = new Course();
        c.setId(10);
        when(courseRepository.findById(10)).thenReturn(Optional.of(c));

        assertThat(service.listQuizzes(10, true)).isEmpty();
    }
}
