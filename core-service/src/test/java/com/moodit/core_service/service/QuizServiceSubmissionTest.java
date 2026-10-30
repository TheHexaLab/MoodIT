package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.AttemptSummaryDTO;
import com.moodit.core_service.dto.CourseQuizStatsDTO;
import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.dto.SubmittedAnswerDTO;
import com.moodit.core_service.exception.AlreadySubmittedException;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Attempt;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.Submission;
import com.moodit.core_service.model.SubmissionTestCase;
import com.moodit.core_service.model.TestCase;
import com.moodit.core_service.model.User;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.dao.DataIntegrityViolationException;

/**
 * Soumission ASYNCHRONE d'une tentative ({@link QuizService#submitQuiz}) et correction en tâche de
 * fond ({@link QuizService#gradeAttempt}) : tentative unique (409), numérotation des reprises,
 * persistance des réponses brutes, évènement de correction, exécution des harnais, finalisation
 * « done » + push WS, et suppression du pending (jamais coincé) en cas d'échec. Couvre aussi les
 * lectures dérivées : historique (getMyAttempts) et agrégat MCP (getCourseQuizStats).
 */
class QuizServiceSubmissionTest extends QuizServiceTestSupport {

    private User eva;

    @BeforeEach
    void setUpUser() {
        eva = user(3, EMAIL);
    }

    // ── submitQuiz ──────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("submitQuiz : enregistrement de la tentative pending")
    class Submit {

        private Question choiceQ;
        private Question codeQ;
        private Quiz quiz;

        @BeforeEach
        void setUp() {
            choiceQ = question(10, SINGLE, 2.0, 0);
            answer(choiceQ, 1, "ok", true);
            codeQ = question(11, CODE, 5.0, 1);
            quiz = quiz(4, course(1), codeQ, choiceQ);
        }

        private QuizSubmissionDTO body(SubmittedAnswerDTO... answers) {
            return QuizSubmissionDTO.builder().quizId(4).answers(List.of(answers)).build();
        }

        @Test
        @DisplayName("Quiz introuvable → QuizNotFoundException, rien d'enregistré")
        void quizIntrouvable_404() {
            when(quizRepository.findById(4)).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(QuizNotFoundException.class);
            verify(attemptRepository, never()).saveAndFlush(any());
            verify(transactionManager).rollback(any());
        }

        @Test
        @DisplayName("Utilisateur introuvable → UserNotFoundException")
        void utilisateurIntrouvable_404() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(UserNotFoundException.class);
        }

        @Test
        @DisplayName("Déjà soumis et reprise interdite → AlreadySubmittedException (409), aucun insert")
        void dejaSoumis_sansReprise_409() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(1L);

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(AlreadySubmittedException.class);
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        /** Quiz à une remise en ordre (éléments 100, 101, 102) pour les cas d'ordre soumis. */
        private Quiz orderingQuiz() {
            Question ordering = question(30, ORDERING, 3.0, 0);
            drag(ordering, 100, "A", 0, null);
            drag(ordering, 101, "B", 1, null);
            drag(ordering, 102, "C", 2, null);
            return quiz(4, course(1), ordering);
        }

        /** Ordre soumis par le client : ids PUBLICS des éléments (ceux de la passation). */
        private SubmittedAnswerDTO ordered(Integer... ids) {
            return SubmittedAnswerDTO.builder().questionId(30)
                    .orderedItemIds(java.util.Arrays.stream(ids)
                            .map(id -> id == null ? null : pub(id)).toList()).build();
        }

        @org.junit.jupiter.params.ParameterizedTest(name = "{0}")
        @org.junit.jupiter.params.provider.MethodSource("ordresMalFormes")
        @DisplayName("Ordre soumis qui n'est pas une permutation des éléments → refusé (400), rien d'enregistré")
        void ordreMalForme_refuse(String cas, Integer[] ids) {
            when(quizRepository.findById(4)).thenReturn(Optional.of(orderingQuiz()));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));

            assertThatThrownBy(() -> service.submitQuiz(4, body(ordered(ids)), EMAIL))
                    .isInstanceOf(com.moodit.core_service.exception.InvalidQuizException.class)
                    .hasMessage("Question 1 : l'ordre soumis doit contenir chaque élément exactement une fois.");
            // La tentative n'est pas consommée : rien n'est écrit, aucune correction lancée.
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        static java.util.stream.Stream<org.junit.jupiter.params.provider.Arguments> ordresMalFormes() {
            return java.util.stream.Stream.of(
                    org.junit.jupiter.params.provider.Arguments.of("élément en trop", new Integer[] {100, 101, 102, 999}),
                    org.junit.jupiter.params.provider.Arguments.of("élément manquant", new Integer[] {100, 101}),
                    org.junit.jupiter.params.provider.Arguments.of("doublon", new Integer[] {100, 100, 101}),
                    org.junit.jupiter.params.provider.Arguments.of("élément d'une autre question", new Integer[] {100, 101, 999}),
                    org.junit.jupiter.params.provider.Arguments.of("id null", new Integer[] {100, null, 102}));
        }

        @Test
        @DisplayName("Ordre complet (permutation, même fausse) ou absent → accepté")
        void ordreValideOuAbsent_accepte() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(orderingQuiz()));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.saveAndFlush(any(Attempt.class))).thenAnswer(inv -> inv.getArgument(0));

            service.submitQuiz(4, body(ordered(102, 100, 101)), EMAIL);
            service.submitQuiz(4, body(ordered()), EMAIL);
            service.submitQuiz(4, body(), EMAIL);

            verify(attemptRepository, org.mockito.Mockito.times(3)).saveAndFlush(any(Attempt.class));
        }

        @Test
        @DisplayName("Première tentative : pending n°1, une soumission par question, évènement publié après")
        void premiereTentative_persisteEtPublie() throws Exception {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(0L);
            when(attemptRepository.saveAndFlush(any(Attempt.class))).thenAnswer(inv -> {
                Attempt a = inv.getArgument(0);
                a.setId(55);
                return a;
            });

            // Seule la question à choix est répondue ; la question Code reste sans réponse.
            Integer id = service.submitQuiz(4, body(choice(10, 1)), EMAIL);

            assertThat(id).isEqualTo(55);
            ArgumentCaptor<Attempt> attemptCaptor = ArgumentCaptor.forClass(Attempt.class);
            verify(attemptRepository).saveAndFlush(attemptCaptor.capture());
            Attempt saved = attemptCaptor.getValue();
            assertThat(saved.getAttemptNo()).isEqualTo(1);
            assertThat(saved.getStatus()).isEqualTo("pending");
            assertThat(saved.getQuiz()).isSameAs(quiz);
            assertThat(saved.getUser()).isSameAs(eva);

            // Soumissions dans l'ordre des questions (orderIndex), réponses brutes sérialisées.
            ArgumentCaptor<Submission> subs = ArgumentCaptor.forClass(Submission.class);
            verify(submissionRepository, times(2)).save(subs.capture());
            Submission first = subs.getAllValues().get(0);
            assertThat(first.getQuestion()).isSameAs(choiceQ);
            assertThat(first.getUser()).isSameAs(eva);
            assertThat(first.getAttempt()).isSameAs(saved);
            SubmittedAnswerDTO stored = objectMapper.readValue(first.getContent(), SubmittedAnswerDTO.class);
            assertThat(stored.getQuestionId()).isEqualTo(10);
            assertThat(stored.getAnswerIds()).containsExactly(1);
            Submission second = subs.getAllValues().get(1);
            assertThat(second.getQuestion()).isSameAs(codeQ);
            assertThat(second.getContent()).isNull();

            ArgumentCaptor<AttemptSubmittedEvent> event = ArgumentCaptor.forClass(AttemptSubmittedEvent.class);
            verify(eventPublisher).publishEvent(event.capture());
            assertThat(event.getValue().attemptId()).isEqualTo(55);
            verify(transactionManager).commit(any());
        }

        @Test
        @DisplayName("Reprise autorisée : numéro = tentatives existantes + 1")
        void repriseAutorisee_numeroSuivant() {
            quiz.setAllowRetry(true);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(2L);
            when(attemptRepository.saveAndFlush(any(Attempt.class))).thenAnswer(inv -> {
                Attempt a = inv.getArgument(0);
                a.setId(56);
                return a;
            });

            service.submitQuiz(4, QuizSubmissionDTO.builder().quizId(4).answers(null).build(), EMAIL);

            ArgumentCaptor<Attempt> attemptCaptor = ArgumentCaptor.forClass(Attempt.class);
            verify(attemptRepository).saveAndFlush(attemptCaptor.capture());
            assertThat(attemptCaptor.getValue().getAttemptNo()).isEqualTo(3);
        }

        @Test
        @DisplayName("Insert concurrent (contrainte UNIQUE / pending) → AlreadySubmittedException, pas d'évènement")
        void violationContrainte_409() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(0L);
            when(attemptRepository.saveAndFlush(any(Attempt.class)))
                    .thenThrow(new DataIntegrityViolationException("uq_attempt_pending"));

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(AlreadySubmittedException.class);
            verifyNoInteractions(submissionRepository, eventPublisher);
        }
    }

    // ── gradeAttempt ────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("gradeAttempt : correction asynchrone du code")
    class Grade {

        private static final int ATTEMPT_ID = 70;
        private Question codeQ;
        private TestCase tcA;
        private TestCase tcB;
        private Quiz quiz;
        private Submission codeSub;
        private Attempt attempt;

        @BeforeEach
        void setUp() {
            codeQ = question(20, CODE, 10.0, 0);
            codeQ.setLanguage(language(2, "python"));
            tcB = testCase(codeQ, 32, "cas B", 0); // poids 0 → envoyé comme 1
            tcA = testCase(codeQ, 31, "cas A", 2);
            Question choiceQ = question(21, SINGLE, 1.0, 1);
            Question codeWithoutHarness = question(22, CODE, 3.0, 2);
            quiz = quiz(4, course(1), codeQ, choiceQ, codeWithoutHarness);
            codeSub = submission(codeQ, SubmittedAnswerDTO.builder().questionId(20).code("print(1)").build());
            Submission choiceSub = submission(choiceQ, choice(21, 1));
            attempt = attempt(ATTEMPT_ID, quiz, eva, 1, "pending", codeSub, choiceSub);
        }

        @Test
        @DisplayName("Tentative disparue → rien n'est exécuté ni poussé")
        void tentativeDisparue_rienAFaire() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.empty());

            service.gradeAttempt(ATTEMPT_ID);

            verifyNoInteractions(executionClient, realtimePublisher, submissionTestCaseRepository);
            verify(attemptRepository, never()).deleteById(anyInt());
        }

        @Test
        @DisplayName("Exécution réussie → verdicts persistés, statut done, push quiz:attempt-graded")
        @SuppressWarnings("unchecked")
        void succes_persisteVerdictsEtPousse() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            // Harnais triés par id (31 puis 32) → verdicts alignés sur cet ordre.
            when(executionClient.evaluate(eq("python"), eq("print(1)"), any())).thenReturn(List.of(true, false));

            service.gradeAttempt(ATTEMPT_ID);

            ArgumentCaptor<List<ExecutionClient.Harness>> harnesses = ArgumentCaptor.forClass(List.class);
            // Une seule question exécutée : celle sans harnais et la question à choix sont ignorées.
            verify(executionClient, times(1)).evaluate(eq("python"), eq("print(1)"), harnesses.capture());
            assertThat(harnesses.getValue()).containsExactly(
                    new ExecutionClient.Harness("cas A", "assert cas A", 2),
                    new ExecutionClient.Harness("cas B", "assert cas B", 1));

            ArgumentCaptor<SubmissionTestCase> verdicts = ArgumentCaptor.forClass(SubmissionTestCase.class);
            verify(submissionTestCaseRepository, times(2)).save(verdicts.capture());
            assertThat(verdicts.getAllValues().get(0).getTestCase()).isSameAs(tcA);
            assertThat(verdicts.getAllValues().get(0).getPassed()).isTrue();
            assertThat(verdicts.getAllValues().get(0).getSubmission()).isSameAs(codeSub);
            assertThat(verdicts.getAllValues().get(1).getTestCase()).isSameAs(tcB);
            assertThat(verdicts.getAllValues().get(1).getPassed()).isFalse();

            assertThat(attempt.getStatus()).isEqualTo("done");
            verify(attemptRepository).save(attempt);
            verify(realtimePublisher).quizAttemptGraded(3L, 4L, ATTEMPT_ID);
            verify(attemptRepository, never()).deleteById(anyInt());
        }

        @Test
        @DisplayName("Question Code sans langage → envoyée avec un langage null")
        void sansLangage_langageNull() {
            codeQ.setLanguage(null);
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any())).thenReturn(List.of(true, true));

            service.gradeAttempt(ATTEMPT_ID);

            verify(executionClient).evaluate(eq(null), eq("print(1)"), any());
            verify(realtimePublisher).quizAttemptGraded(3L, 4L, ATTEMPT_ID);
        }

        @Test
        @DisplayName("Sandbox indisponible (null) → pending SUPPRIMÉ et push quiz:attempt-failed")
        void sandboxIndisponible_supprimeEtNotifie() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any())).thenReturn(null);

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).deleteById(ATTEMPT_ID);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
            verify(realtimePublisher, never()).quizAttemptGraded(anyLong(), anyLong(), anyLong());
            verifyNoInteractions(submissionTestCaseRepository);
            assertThat(attempt.getStatus()).isEqualTo("pending");
        }

        @Test
        @DisplayName("Nombre de verdicts incohérent → traité comme une indisponibilité (suppression)")
        void verdictsIncoherents_supprime() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any())).thenReturn(List.of(true));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).deleteById(ATTEMPT_ID);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
        }

        @Test
        @DisplayName("Erreur inattendue pendant l'exécution → pending supprimé quand même")
        void erreurInattendue_supprime() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any())).thenThrow(new IllegalStateException("boom"));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).deleteById(ATTEMPT_ID);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
        }

        @Test
        @DisplayName("Destinataire introuvable lors de l'échec → suppression faite, aucun push")
        void echecEtLookupImpossible_supprimeSansPush() {
            when(attemptRepository.findById(ATTEMPT_ID))
                    .thenReturn(Optional.of(attempt))
                    .thenThrow(new IllegalStateException("BD indisponible"));
            when(executionClient.evaluate(any(), any(), any())).thenReturn(null);

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).deleteById(ATTEMPT_ID);
            verifyNoInteractions(realtimePublisher);
        }

        @Test
        @DisplayName("Tentative supprimée avant la finalisation → échec : suppression, pas de push")
        void disparueAvantFinalisation_echec() {
            when(attemptRepository.findById(ATTEMPT_ID))
                    .thenReturn(Optional.of(attempt))   // contexte
                    .thenReturn(Optional.empty());      // finalisation, puis lookup de l'échec
            when(executionClient.evaluate(any(), any(), any())).thenReturn(List.of(true, true));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).deleteById(ATTEMPT_ID);
            verify(attemptRepository, never()).save(any());
            verifyNoInteractions(realtimePublisher);
        }

        @Test
        @DisplayName("Push WS en échec après correction → la tentative corrigée n'est PAS supprimée")
        void pushEchoue_tentativeConservee() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any())).thenReturn(List.of(true, true));
            doThrow(new IllegalStateException("WS fermé"))
                    .when(realtimePublisher).quizAttemptGraded(3L, 4L, ATTEMPT_ID);

            service.gradeAttempt(ATTEMPT_ID);

            assertThat(attempt.getStatus()).isEqualTo("done");
            verify(attemptRepository, never()).deleteById(anyInt());
            verify(realtimePublisher, never())
                    .quizAttemptFailed(anyLong(), anyLong(), anyLong(), any());
        }

        @Test
        @DisplayName("Quiz sans question Code → aucune exécution, tentative passée en done")
        void sansCode_doneDirect() {
            Question onlyChoice = question(40, SINGLE, 1.0, 0);
            Quiz plain = quiz(5, course(1), onlyChoice);
            Attempt a = attempt(ATTEMPT_ID, plain, eva, 1, "pending", submission(onlyChoice, choice(40, 1)));
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(a));

            service.gradeAttempt(ATTEMPT_ID);

            verifyNoInteractions(executionClient, submissionTestCaseRepository);
            assertThat(a.getStatus()).isEqualTo("done");
            verify(realtimePublisher).quizAttemptGraded(3L, 5L, ATTEMPT_ID);
        }
    }

    // ── getMyAttempts ───────────────────────────────────────────────────────────

    @Test
    @DisplayName("Historique : seules les tentatives done, score recalculé et date en UTC")
    void getMyAttempts_filtreLesPendingEtCalculeLeScore() {
        Question q = question(10, SINGLE, 2.0, 0);
        answer(q, 1, "ok", true);
        Quiz quiz = quiz(4, course(1), q);
        Attempt done = attempt(80, quiz, eva, 1, "done", submission(q, choice(10, 1)));
        done.setSubmittedAt(LocalDateTime.of(2026, 9, 2, 8, 30));
        Attempt pending = attempt(81, quiz, eva, 2, "pending", submission(q, choice(10, 1)));
        Attempt undated = attempt(82, quiz, eva, 3, "done", submission(q, choice(10, 2)));
        when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
        when(attemptRepository.findByQuiz_IdAndUser_IdOrderByAttemptNoAsc(4, 3))
                .thenReturn(List.of(done, pending, undated));

        List<AttemptSummaryDTO> history = service.getMyAttempts(4, EMAIL);

        assertThat(history).extracting(AttemptSummaryDTO::getId).containsExactly(80, 82);
        AttemptSummaryDTO first = history.get(0);
        assertThat(first.getAttemptNo()).isEqualTo(1);
        assertThat(first.getEarned()).isEqualTo(2.0);
        assertThat(first.getMax()).isEqualTo(2.0);
        assertThat(first.getSubmittedAt()).isEqualTo(Instant.parse("2026-09-02T08:30:00Z"));
        assertThat(history.get(1).getEarned()).isZero();
        assertThat(history.get(1).getSubmittedAt()).isNull();
    }

    @Test
    @DisplayName("Historique d'un utilisateur inconnu → UserNotFoundException")
    void getMyAttempts_utilisateurInconnu() {
        when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getMyAttempts(4, EMAIL))
                .isInstanceOf(UserNotFoundException.class);
    }

    // ── getCourseQuizStats ──────────────────────────────────────────────────────

    @Test
    @DisplayName("Stats MCP : moyenne des % par tentative, Code exclu, pending et tentatives sans barème ignorées")
    void getCourseQuizStats_agregeHorsCode() {
        Question choiceQ = question(10, SINGLE, 2.0, 0);
        answer(choiceQ, 1, "ok", true);
        answer(choiceQ, 2, "ko", false);
        Question codeQ = question(11, CODE, 8.0, 1);
        Quiz quiz = quiz(4, course(1), choiceQ, codeQ);
        Question onlyCode = question(12, CODE, 5.0, 0);
        Quiz codeQuiz = quiz(5, course(1), onlyCode);

        User bob = user(4, "bob@test.ca");
        Attempt evaFull = attempt(1, quiz, eva, 1, "done", submission(choiceQ, choice(10, 1)));
        Attempt evaZero = attempt(2, quiz, eva, 2, "done", submission(choiceQ, choice(10, 2)));
        Attempt bobFull = attempt(3, quiz, bob, 1, "done", submission(choiceQ, choice(10, 1)));
        Attempt bobPending = attempt(4, quiz, bob, 2, "pending", submission(choiceQ, choice(10, 2)));
        Attempt codeOnly = attempt(5, codeQuiz, bob, 1, "done", submission(onlyCode, null));
        when(attemptRepository.findByQuiz_Course_Id(1))
                .thenReturn(List.of(evaFull, evaZero, bobFull, bobPending, codeOnly));

        CourseQuizStatsDTO stats = service.getCourseQuizStats(1);

        // (100 + 0 + 100) / 3 = 66,67 → 67 ; 3 tentatives notées ; 2 étudiants distincts.
        assertThat(stats.averageScorePercent()).isEqualTo(67);
        assertThat(stats.gradedAttemptCount()).isEqualTo(3);
        assertThat(stats.studentCount()).isEqualTo(2);
    }

    @Test
    @DisplayName("Stats MCP sans tentative → moyenne null, compteurs à 0")
    void getCourseQuizStats_vide() {
        when(attemptRepository.findByQuiz_Course_Id(1)).thenReturn(List.of());

        CourseQuizStatsDTO stats = service.getCourseQuizStats(1);

        assertThat(stats.averageScorePercent()).isNull();
        assertThat(stats.gradedAttemptCount()).isZero();
        assertThat(stats.studentCount()).isZero();
    }
}
