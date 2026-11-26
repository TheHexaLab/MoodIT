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
import com.moodit.core_service.dto.ReviewAttemptDTO;
import com.moodit.core_service.dto.SubmittedAnswerDTO;
import com.moodit.core_service.exception.AlreadySubmittedException;
import com.moodit.core_service.exception.AttemptNotFoundException;
import com.moodit.core_service.exception.AttemptNotReviewableException;
import com.moodit.core_service.exception.CodeVerificationNoVerdictException;
import com.moodit.core_service.exception.GradingInProgressException;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.exception.RegradeInProgressException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Attempt;
import com.moodit.core_service.model.GradingFailure;
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
import org.springframework.core.task.TaskRejectedException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.transaction.TransactionDefinition;

/**
 * Soumission ASYNCHRONE d'une tentative ({@link QuizService#submitQuiz}) et correction en tâche de
 * fond ({@link QuizService#gradeAttempt}) : tentative unique (409), numérotation des reprises,
 * persistance des réponses brutes, évènement de correction, exécution des harnais, finalisation
 * « done » + push WS, et suppression du pending (jamais coincé) en cas d'échec — sauf trois cas :
 * une correction INTERROMPUE par l'arrêt de core laisse la tentative pending (reprise au
 * démarrage) ; le plafond atteint la GARDE « à revoir » (échec sans verdict compté par étudiant et
 * par quiz, ou toute panne sur un quiz sans reprise) ; une relance de l'enseignant en échec revient
 * « à revoir » par son marqueur, quel que soit le compte (#116, S4). Couvre
 * aussi les lectures dérivées : historique (getMyAttempts, tentatives à revoir comprises), liste
 * des tentatives à revoir et agrégat MCP (getCourseQuizStats).
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

        /** Tentative pending d'Éva sur ce quiz (id 55), dont la correction est en cours. */
        private Attempt pendingAttempt() {
            return attempt(55, quiz, eva, 1, "pending");
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
        @DisplayName("Tentative déjà corrigée (done) et reprise interdite → AlreadySubmittedException (409 texte), aucun insert")
        void dejaSoumis_sansReprise_409() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            // Aucune correction en cours : la tentative existante est terminée.
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.empty());
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(1L);

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(AlreadySubmittedException.class);
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        @Test
        @DisplayName("Correction déjà en cours (pending), quiz sans reprise → GradingInProgressException, pas « déjà soumis »")
        void pendingAttempt_noRetry_inProgress() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            // Le pending compte parmi les tentatives : un comptage de 1 lèverait « déjà soumis »
            // si la tentative unique était appliquée AVANT la recherche du pending.
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(1L);
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.of(pendingAttempt()));
            // Pending ordinaire : la correction d'une soumission de l'étudiant, pas une relance.
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(false);

            // Le pending compte aussi parmi les tentatives : vérifié AVANT la tentative unique, il
            // ne retombe pas dans le 409 « déjà soumis ».
            // Avec l'id du pending : le client attend CETTE tentative, sans la deviner.
            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(GradingInProgressException.class)
                    .hasMessage("Une correction de ce quiz est déjà en cours.")
                    .extracting(e -> ((GradingInProgressException) e).getAttemptId())
                    .isEqualTo(55);
            // L'ordre des DÉCISIONS est épinglé : le comptage a lieu (avant la recherche, cf.
            // concurrentPendingCommittedBetweenReads_inProgressWithItsId), mais la tentative
            // unique n'est appliquée qu'après le pending.
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        @Test
        @DisplayName("Pending = RELANCE de l'enseignant, quiz AVEC reprise → RegradeInProgressException (« relance »), pas « en cours »")
        void pendingRegrade_withRetry_regradeInProgress() {
            // Quiz AVEC reprise : l'étudiant pourra resoumettre une fois la relance finie.
            quiz.setAllowRetry(true);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(1L);
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.of(pendingAttempt()));
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(true);

            // Le verdict de cette relance n'est pas celui de la soumission : le client ne doit pas
            // l'attendre comme le sien.
            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(RegradeInProgressException.class)
                    .hasMessage("Votre tentative précédente est en cours de recorrection par votre"
                            + " enseignant. Réessayez plus tard.");
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        @Test
        @DisplayName("Pending = RELANCE de l'enseignant, quiz SANS reprise → AlreadySubmittedException (« réessayez » mènerait à ce refus)")
        void pendingRegrade_noRetry_alreadySubmitted() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.of(pendingAttempt()));
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(true);

            // La relance porte forcément sur la tentative unique : elle est consommée.
            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(AlreadySubmittedException.class);
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        /**
         * Soumission concurrente (n° 3, id 60) VALIDÉE ENTRE les deux lectures du contrôle
         * préalable : la première ne la voit pas, la seconde la voit (READ COMMITTED), quel que
         * soit l'ordre des requêtes.
         */
        private void concurrentPendingCommittedBetweenTheTwoReads() {
            java.util.concurrent.atomic.AtomicInteger reads = new java.util.concurrent.atomic.AtomicInteger();
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3))
                    .thenAnswer(inv -> reads.getAndIncrement() == 0 ? 2L : 3L);
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenAnswer(inv -> reads.getAndIncrement() == 0 ? Optional.empty()
                            : Optional.of(attempt(60, quiz, eva, 3, "pending")));
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(false);
        }

        @org.junit.jupiter.params.ParameterizedTest(name = "reprise = {0}")
        @org.junit.jupiter.params.provider.ValueSource(booleans = {true, false})
        @DisplayName("Pending concurrent validé entre le comptage et la recherche → « en cours » avec SON id, jamais « déjà soumis » ni sans id")
        void concurrentPendingCommittedBetweenReads_inProgressWithItsId(boolean allowRetry) {
            // Compter AVANT de chercher le pending : la recherche voit alors la soumission validée
            // entre les deux. Dans l'ordre inverse, elle lui échappait mais entrait dans le
            // compte — sans reprise « déjà soumis », avec reprise un n° 4 tenté puis un conflit
            // qui écartait la n° 3 comme trop ancienne (409 sans id).
            quiz.setAllowRetry(allowRetry);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            concurrentPendingCommittedBetweenTheTwoReads();

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(GradingInProgressException.class)
                    .extracting(e -> ((GradingInProgressException) e).getAttemptId())
                    .isEqualTo(60);
            verify(attemptRepository, never()).saveAndFlush(any());
        }

        @Test
        @DisplayName("Correction déjà en cours (pending), quiz AVEC reprise → GradingInProgressException, aucun insert")
        void pendingAttempt_withRetry_inProgress() {
            quiz.setAllowRetry(true);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.of(pendingAttempt()));

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(GradingInProgressException.class);
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        @Test
        @DisplayName("Code soumis au-delà de la borne d'execution-service → refusé (400), tentative non consommée")
        void codeTooLong_rejected() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            SubmittedAnswerDTO tooLong = SubmittedAnswerDTO.builder().questionId(11)
                    .code("x".repeat(QuizService.MAX_CODE_CHARS + 1)).build();

            assertThatThrownBy(() -> service.submitQuiz(4, body(tooLong), EMAIL))
                    .isInstanceOf(com.moodit.core_service.exception.InvalidQuizException.class)
                    .hasMessage("Question 2 : le code soumis dépasse 100000 caractères.");
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        @Test
        @DisplayName("Code soumis pile à la borne (100 000 caractères) → accepté")
        void codeAtLimit_accepted() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.saveAndFlush(any(Attempt.class))).thenAnswer(inv -> {
                Attempt a = inv.getArgument(0);
                a.setId(56);
                return a;
            });
            SubmittedAnswerDTO atLimit = SubmittedAnswerDTO.builder().questionId(11)
                    .code("x".repeat(QuizService.MAX_CODE_CHARS)).build();

            assertThat(service.submitQuiz(4, body(atLimit), EMAIL)).isEqualTo(56);
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
        void ordreMalForme_refuse(String caseInput, Integer[] ids) {
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
            // La question Code n'a aucun harnais : rien à exécuter, donc pool rapide.
            assertThat(event.getValue().needsSandbox()).isFalse();
            verify(transactionManager).commit(any());
        }

        @Test
        @DisplayName("Question Code avec harnais → évènement marqué needsSandbox (pool du code)")
        void codeQuestionWithHarness_needsSandbox() {
            testCase(codeQ, 90, "cas", 1);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.saveAndFlush(any(Attempt.class))).thenAnswer(inv -> {
                Attempt a = inv.getArgument(0);
                a.setId(57);
                return a;
            });

            service.submitQuiz(4, body(), EMAIL);

            ArgumentCaptor<AttemptSubmittedEvent> event = ArgumentCaptor.forClass(AttemptSubmittedEvent.class);
            verify(eventPublisher).publishEvent(event.capture());
            assertThat(event.getValue()).isEqualTo(new AttemptSubmittedEvent(57, true));
        }

        @Test
        @DisplayName("Harnais sur une question qui n'est pas de type Code → pas de sandbox")
        void harnessOnNonCodeQuestion_noSandbox() {
            testCase(choiceQ, 91, "cas", 1);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.saveAndFlush(any(Attempt.class))).thenAnswer(inv -> inv.getArgument(0));

            service.submitQuiz(4, body(), EMAIL);

            ArgumentCaptor<AttemptSubmittedEvent> event = ArgumentCaptor.forClass(AttemptSubmittedEvent.class);
            verify(eventPublisher).publishEvent(event.capture());
            assertThat(event.getValue().needsSandbox()).isFalse();
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
        @DisplayName("Insert concurrent, l'autre soumission déjà corrigée à la relecture → GradingInProgressException, jamais « déjà soumis »")
        void constraintViolation_otherSubmissionAlreadyGraded_stillInProgress() {
            // Quiz AVEC reprise et sans harnais : la soumission gagnante passe en done en quelques
            // millisecondes, avant la relecture, qui ne trouve plus aucun pending. Le conflit
            // vient pourtant d'une écriture concurrente du même étudiant : c'est « en cours ».
            quiz.setAllowRetry(true);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.empty());
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(2L);
            when(attemptRepository.saveAndFlush(any(Attempt.class)))
                    .thenThrow(new DataIntegrityViolationException("uq_quiz_user_attempt_no"));
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(false);
            // La dernière tentative relue : celle de l'écriture concurrente, déjà corrigée, au
            // n° 3 — celui que cette soumission a tenté d'insérer (borne incluse).
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdOrderByAttemptNoDesc(4, 3))
                    .thenReturn(Optional.of(attempt(57, quiz, eva, 3, "done")));

            // Son id accompagne le 409 : le client l'attend (son verdict est déjà là) au lieu de
            // la deviner par une relecture de l'historique qui l'écarterait.
            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(GradingInProgressException.class)
                    .extracting(e -> ((GradingInProgressException) e).getAttemptId())
                    .isEqualTo(57);
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        /**
         * Conflit d'insertion sur un quiz AVEC reprise et {@code prior} tentatives antérieures
         * (la soumission tente le n° prior + 1) ; la relecture de la dernière tentative rend
         * {@code reread}.
         */
        private Throwable conflictWithLatestAttempt(long prior, Attempt reread, String constraint) {
            quiz.setAllowRetry(true);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.empty());
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(prior);
            when(attemptRepository.saveAndFlush(any(Attempt.class)))
                    .thenThrow(new DataIntegrityViolationException(constraint));
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(false);
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdOrderByAttemptNoDesc(4, 3))
                    .thenReturn(Optional.of(reread));
            return org.assertj.core.api.Assertions.catchThrowable(() -> service.submitQuiz(4, body(), EMAIL));
        }

        @Test
        @DisplayName("Insert concurrent, concurrente supprimée avant la relecture : l'ANCIENNE tentative relue n'est pas renvoyée (pas d'id)")
        void constraintViolation_concurrentDeleted_olderAttemptNotReturned() {
            // La concurrente (n° 3) a vu sa correction abandonnée et a été supprimée : la dernière
            // tentative relue est la n° 2, déjà corrigée. Son id ferait ouvrir au client ce
            // résultat comme celui de son envoi.
            Throwable thrown = conflictWithLatestAttempt(2, attempt(41, quiz, eva, 2, "done"),
                    "uq_quiz_user_attempt_no");

            assertThat(thrown).isInstanceOf(GradingInProgressException.class);
            assertThat(((GradingInProgressException) thrown).getAttemptId()).isNull();
        }

        @Test
        @DisplayName("Insert concurrent avec la relance de l'UNIQUE tentative, finie avant la relecture : l'écriture concurrente elle-même est écartée (pas d'id)")
        void constraintViolation_regradeFinishedBeforeReread_noId() {
            // Différent du cas précédent : ici, la dernière tentative relue EST l'écriture
            // concurrente — la relance de la n° 1, qui a fait échouer l'insert du n° 2
            // (uq_attempt_pending) puis s'est terminée (plus de marqueur de relance). Son verdict
            // est celui d'une ancienne tentative, pas de cet envoi : écartée quand même.
            Throwable thrown = conflictWithLatestAttempt(1, attempt(42, quiz, eva, 1, "done"),
                    "uq_attempt_pending");

            assertThat(thrown).isInstanceOf(GradingInProgressException.class);
            assertThat(((GradingInProgressException) thrown).getAttemptId()).isNull();
        }

        @Test
        @DisplayName("Insert concurrent, tentative concurrente disparue à la relecture → « en cours » sans id (repli du client)")
        void constraintViolation_otherAttemptGone_inProgressWithoutId() {
            quiz.setAllowRetry(true);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.empty());
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(0L);
            when(attemptRepository.saveAndFlush(any(Attempt.class)))
                    .thenThrow(new DataIntegrityViolationException("uq_attempt_pending"));
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(false);
            // Supprimée entre-temps (correction abandonnée) : plus aucune tentative.
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdOrderByAttemptNoDesc(4, 3))
                    .thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(GradingInProgressException.class)
                    .extracting(e -> ((GradingInProgressException) e).getAttemptId())
                    .isNull();
        }

        @Test
        @DisplayName("Insert concurrent avec une RELANCE de l'enseignant, quiz AVEC reprise → RegradeInProgressException, relue dans une transaction NOUVELLE")
        void constraintViolation_regradeReread_regradeInProgress() {
            quiz.setAllowRetry(true);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            // Contrôle préalable : rien encore ; l'enseignant relance une tentative « à revoir »
            // entre-temps, et son pending (marqué relance) fait échouer l'insert.
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.empty());
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(0L);
            when(attemptRepository.saveAndFlush(any(Attempt.class)))
                    .thenThrow(new DataIntegrityViolationException("uq_attempt_pending"));
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(true);

            assertThatThrownBy(() -> service.submitQuiz(4, body(), EMAIL))
                    .isInstanceOf(RegradeInProgressException.class);
            // La transaction de l'insert est annulée (inutilisable sous PostgreSQL après l'erreur) ;
            // la relecture se fait dans une seconde transaction, en lecture seule.
            ArgumentCaptor<TransactionDefinition> defs = ArgumentCaptor.forClass(TransactionDefinition.class);
            verify(transactionManager, times(2)).getTransaction(defs.capture());
            assertThat(defs.getAllValues().get(0).isReadOnly()).isFalse();
            assertThat(defs.getAllValues().get(1).isReadOnly()).isTrue();
            verify(transactionManager).rollback(any());
            // ORDRE : la relecture ne commence qu'APRÈS le rollback. Une relecture lancée dans le
            // catch de l'insert rejoindrait la transaction PostgreSQL en échec (25P02) → 500.
            org.mockito.InOrder order = org.mockito.Mockito.inOrder(transactionManager);
            order.verify(transactionManager).getTransaction(
                    org.mockito.ArgumentMatchers.argThat(d -> d != null && !d.isReadOnly()));
            order.verify(transactionManager).rollback(any());
            order.verify(transactionManager).getTransaction(
                    org.mockito.ArgumentMatchers.argThat(d -> d != null && d.isReadOnly()));
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        @Test
        @DisplayName("Insert concurrent avec une RELANCE, quiz SANS reprise → AlreadySubmittedException (même règle que le contrôle préalable)")
        void constraintViolation_regradeReread_noRetry_alreadySubmitted() {
            // En pratique inatteignable (une relance suppose une tentative « à revoir », que le
            // comptage aurait refusée) : la règle reste celle du contrôle préalable.
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(4, 3, "pending"))
                    .thenReturn(Optional.empty());
            when(attemptRepository.countByQuiz_IdAndUser_Id(4, 3)).thenReturn(0L);
            when(attemptRepository.saveAndFlush(any(Attempt.class)))
                    .thenThrow(new DataIntegrityViolationException("uq_attempt_pending"));
            when(attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(4, 3, "pending", true))
                    .thenReturn(true);

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
            verify(attemptRepository, never()).delete(any(Attempt.class));
        }

        @Test
        @DisplayName("Exécution réussie → verdicts persistés, statut done, push quiz:attempt-graded")
        @SuppressWarnings("unchecked")
        void succes_persisteVerdictsEtPousse() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            // Le temps limite de la QUESTION doit arriver tel quel à l'exécution (épinglé par
            // eq(30_000) plus bas : un null silencieux passerait avec any()).
            codeQ.setExecTimeoutMs(30_000);
            // Le code de départ aussi (#22) : il dit à execution-service quel nom l'énoncé impose.
            codeQ.setStartCode("def sum(l):\n    pass");
            // Harnais triés par id (31 puis 32) → verdicts alignés sur cet ordre.
            when(executionClient.evaluate(eq("python"), eq("print(1)"), any(), eq(30_000),
                    eq("def sum(l):\n    pass"))).thenReturn(List.of(true, false));

            service.gradeAttempt(ATTEMPT_ID);

            ArgumentCaptor<List<ExecutionClient.Harness>> harnesses = ArgumentCaptor.forClass(List.class);
            // Une seule question exécutée : celle sans harnais et la question à choix sont ignorées.
            verify(executionClient, times(1)).evaluate(eq("python"), eq("print(1)"), harnesses.capture(), eq(30_000),
                    eq("def sum(l):\n    pass"));
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
            verify(attemptRepository, never()).delete(any(Attempt.class));
            // Correction aboutie : le compte des échecs sans verdict repart de zéro (#116, S4).
            verify(gradingFailureRepository).deleteById(new GradingFailure.Key(4, 3));
        }

        @Test
        @DisplayName("Question Code sans langage → envoyée avec un langage null")
        void sansLangage_langageNull() {
            codeQ.setLanguage(null);
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(List.of(true, true));

            service.gradeAttempt(ATTEMPT_ID);

            verify(executionClient).evaluate(eq(null), eq("print(1)"), any(), any(), any());
            verify(realtimePublisher).quizAttemptGraded(3L, 4L, ATTEMPT_ID);
        }

        @Test
        @DisplayName("Correction interrompue par l'arrêt de core → tentative LAISSÉE pending (reprise au démarrage)")
        void interruptedGrading_leavesPending() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any()))
                    .thenThrow(new com.moodit.core_service.exception.GradingInterruptedException());

            service.gradeAttempt(ATTEMPT_ID);

            // Ni suppression, ni verdict, ni notification : resumePendingGradings la reprendra.
            verify(attemptRepository, never()).delete(any());
            verify(attemptRepository, never()).findByIdForUpdate(any());
            verify(realtimePublisher, never()).quizAttemptFailed(anyLong(), anyLong(), anyLong(), any());
            verify(realtimePublisher, never()).quizAttemptGraded(anyLong(), anyLong(), anyLong());
            verifyNoInteractions(submissionTestCaseRepository);
            assertThat(attempt.getStatus()).isEqualTo("pending");
        }

        @Test
        @DisplayName("Sandbox indisponible (null) → pending SUPPRIMÉ et push quiz:attempt-failed")
        void sandboxIndisponible_supprimeEtNotifie() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(null);
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).delete(attempt);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
            verify(realtimePublisher, never()).quizAttemptGraded(anyLong(), anyLong(), anyLong());
            verifyNoInteractions(submissionTestCaseRepository);
            assertThat(attempt.getStatus()).isEqualTo("pending");
        }

        @Test
        @DisplayName("Relance qui échoue sur un quiz avec reprise, compte remis à zéro → REMISE à revoir, pas supprimée")
        void failedRegrade_backToReview() {
            // Une autre tentative corrigée entre-temps a effacé le compte (aucun GradingFailure) :
            // seul le marqueur de relance garde la tentative.
            attempt.setRegrade(true);
            quiz.setAllowRetry(true);
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(null);
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

            service.gradeAttempt(ATTEMPT_ID);

            assertThat(attempt.getStatus()).isEqualTo(QuizService.REVIEW);
            verify(attemptRepository, never()).delete(any(Attempt.class));
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, QuizService.REVIEW);
        }

        @Test
        @DisplayName("Relance qui aboutit → tentative 'done' et marqueur de relance retiré")
        void successfulRegrade_clearsRegradeFlag() {
            attempt.setRegrade(true);
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(List.of(true, false));

            service.gradeAttempt(ATTEMPT_ID);

            assertThat(attempt.getStatus()).isEqualTo("done");
            assertThat(attempt.isRegrade()).isFalse();
        }

        @Test
        @DisplayName("Démarrage → chaque pending revient avec son pool (harnais ou non)")
        void pendingGradings_routedByHarness() {
            Question choiceOnly = question(40, SINGLE, 1.0, 0);
            Quiz choiceQuiz = quiz(5, course(1), choiceOnly);
            Attempt choiceAttempt = attempt(71, choiceQuiz, eva, 1, "pending");
            when(attemptRepository.findByStatusOrderByIdAsc("pending"))
                    .thenReturn(List.of(attempt, choiceAttempt));

            assertThat(service.pendingGradings()).containsExactly(
                    new AttemptSubmittedEvent(ATTEMPT_ID, true),
                    new AttemptSubmittedEvent(71, false));
            verifyNoInteractions(executionClient, realtimePublisher);
            verify(attemptRepository, never()).delete(any(Attempt.class));
        }

        @Test
        @DisplayName("Démarrage sans pending → liste vide")
        void pendingGradings_none() {
            when(attemptRepository.findByStatusOrderByIdAsc("pending")).thenReturn(List.of());

            assertThat(service.pendingGradings()).isEmpty();
        }

        @Test
        @DisplayName("Correction refusée par l'executor → pending supprimé dans une NOUVELLE transaction, push failed")
        void abandon_deletesInNewTransaction() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

            service.abandonGrading(ATTEMPT_ID, new TaskRejectedException("file pleine"));

            verify(attemptRepository).delete(attempt);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
            verifyNoInteractions(executionClient);
            // Appelé depuis le rappel after-commit de la soumission : en REQUIRED, la lecture et la
            // suppression rejoindraient la transaction déjà committée et ne seraient jamais écrites.
            ArgumentCaptor<TransactionDefinition> defs = ArgumentCaptor.forClass(TransactionDefinition.class);
            verify(transactionManager, times(2)).getTransaction(defs.capture());
            assertThat(defs.getAllValues()).allSatisfy(def -> assertThat(def.getPropagationBehavior())
                    .isEqualTo(TransactionDefinition.PROPAGATION_REQUIRES_NEW));
        }

        @Test
        @DisplayName("Nombre de verdicts incohérent → traité comme une indisponibilité (suppression)")
        void verdictsIncoherents_supprime() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(List.of(true));
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).delete(attempt);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
        }

        @Test
        @DisplayName("Erreur inattendue pendant l'exécution → pending supprimé quand même")
        void erreurInattendue_supprime() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenThrow(new IllegalStateException("boom"));
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).delete(attempt);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
        }

        @Test
        @DisplayName("Destinataire introuvable lors de l'échec → suppression faite, aucun push")
        void echecEtLookupImpossible_supprimeSansPush() {
            when(attemptRepository.findById(ATTEMPT_ID))
                    .thenReturn(Optional.of(attempt))
                    .thenThrow(new IllegalStateException("BD indisponible"));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(null);
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).delete(attempt);
            verifyNoInteractions(realtimePublisher);
        }

        @Test
        @DisplayName("Tentative supprimée avant la finalisation → échec sans suppression (déjà disparue), pas de push")
        void disparueAvantFinalisation_echec() {
            when(attemptRepository.findById(ATTEMPT_ID))
                    .thenReturn(Optional.of(attempt))   // contexte
                    .thenReturn(Optional.empty());      // finalisation, puis lookup de l'échec
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(List.of(true, true));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).findByIdForUpdate(ATTEMPT_ID);
            verify(attemptRepository, never()).delete(any(Attempt.class));
            verify(attemptRepository, never()).save(any());
            verifyNoInteractions(realtimePublisher);
        }

        @Test
        @DisplayName("Tentative déjà corrigée (reprise au démarrage) → rien n'est exécuté, ni supprimé, ni poussé")
        void alreadyGraded_nothingToDo() {
            attempt.setStatus("done");
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

            service.gradeAttempt(ATTEMPT_ID);

            verifyNoInteractions(executionClient, realtimePublisher, submissionTestCaseRepository);
            verify(attemptRepository, never()).delete(any(Attempt.class));
            verify(attemptRepository, never()).save(any());
        }

        @Test
        @DisplayName("Finalisée par une autre passe pendant l'exécution → aucune écriture, aucun push, pas de suppression")
        void finalizedByOtherPass_ignored() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenAnswer(inv -> {
                attempt.setStatus("done"); // l'autre passe a committé pendant le sandbox
                return List.of(true, true);
            });

            service.gradeAttempt(ATTEMPT_ID);

            verifyNoInteractions(submissionTestCaseRepository, realtimePublisher);
            verify(attemptRepository, never()).save(any());
            verify(attemptRepository, never()).delete(any(Attempt.class));
        }

        @Test
        @DisplayName("Échec d'une passe alors que l'autre a finalisé → la tentative done n'est PAS supprimée, aucun push failed")
        void failureAfterOtherPassFinalized_nothingDeleted() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            // Clé (submission, test_case) déjà écrite par l'autre passe.
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(List.of(true, true));
            when(submissionTestCaseRepository.save(any()))
                    .thenThrow(new DataIntegrityViolationException("pk"));
            // Relue sous verrou : l'autre passe l'a finalisée.
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID))
                    .thenReturn(Optional.of(attempt(ATTEMPT_ID, quiz, eva, 1, "done")));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository, never()).delete(any(Attempt.class));
            verifyNoInteractions(realtimePublisher);
        }

        @Test
        @DisplayName("Push WS en échec après correction → la tentative corrigée n'est PAS supprimée")
        void pushEchoue_tentativeConservee() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(List.of(true, true));
            doThrow(new IllegalStateException("WS fermé"))
                    .when(realtimePublisher).quizAttemptGraded(3L, 4L, ATTEMPT_ID);

            service.gradeAttempt(ATTEMPT_ID);

            assertThat(attempt.getStatus()).isEqualTo("done");
            verify(attemptRepository, never()).delete(any(Attempt.class));
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

        // ── Plafond des échecs SANS VERDICT (#116, S4) ──────────────────────────────

        private void failsWithoutVerdict() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any()))
                    .thenThrow(new CodeVerificationNoVerdictException());
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        }

        private static GradingFailure failures(int count) {
            GradingFailure f = new GradingFailure();
            f.setQuizId(4);
            f.setUserId(3);
            f.setNoVerdictCount(count);
            return f;
        }

        @Test
        @DisplayName("Sans verdict sous le plafond → pending supprimé, échec compté, raison générique")
        void noVerdict_belowCap_deletesAndCounts() {
            failsWithoutVerdict();

            service.gradeAttempt(ATTEMPT_ID);

            ArgumentCaptor<GradingFailure> saved = ArgumentCaptor.forClass(GradingFailure.class);
            verify(gradingFailureRepository).save(saved.capture());
            assertThat(saved.getValue().getQuizId()).isEqualTo(4);
            assertThat(saved.getValue().getUserId()).isEqualTo(3);
            assertThat(saved.getValue().getNoVerdictCount()).isEqualTo(1);
            assertThat(saved.getValue().getLastFailureAt()).isNotNull();
            verify(attemptRepository).delete(attempt);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
        }

        @Test
        @DisplayName("Sans verdict au plafond → tentative GARDÉE à revoir, raison « review »")
        void noVerdict_atCap_keeps() {
            failsWithoutVerdict();
            when(gradingFailureRepository.findById(new GradingFailure.Key(4, 3)))
                    .thenReturn(Optional.of(failures(2)));

            service.gradeAttempt(ATTEMPT_ID);

            assertThat(attempt.getStatus()).isEqualTo(QuizService.REVIEW);
            verify(attemptRepository).save(attempt);
            verify(attemptRepository, never()).delete(any(Attempt.class));
            ArgumentCaptor<GradingFailure> saved = ArgumentCaptor.forClass(GradingFailure.class);
            verify(gradingFailureRepository).save(saved.capture());
            assertThat(saved.getValue().getNoVerdictCount()).isEqualTo(3);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, QuizService.REVIEW);
            verifyNoInteractions(submissionTestCaseRepository);
        }

        @Test
        @DisplayName("Plafond configurable : à 1, le premier échec sans verdict garde la tentative")
        void noVerdict_configurableCap() {
            service.setMaxNoVerdictFailures(1);
            failsWithoutVerdict();

            service.gradeAttempt(ATTEMPT_ID);

            assertThat(attempt.getStatus()).isEqualTo(QuizService.REVIEW);
            verify(attemptRepository, never()).delete(any(Attempt.class));
        }

        @Test
        @DisplayName("Sandbox INDISPONIBLE sous le plafond → supprimée, rien n'est compté")
        void unavailable_notCounted() {
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(null);
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(gradingFailureRepository.findById(new GradingFailure.Key(4, 3)))
                    .thenReturn(Optional.of(failures(2)));

            service.gradeAttempt(ATTEMPT_ID);

            verify(gradingFailureRepository, never()).save(any());
            verify(attemptRepository).delete(attempt);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
        }

        @Test
        @DisplayName("Quiz SANS reprise, plafond déjà atteint, tentative non relancée : même une panne garde la tentative")
        void capReached_noRetry_outageKeeps() {
            // Préconditions de l'intitulé : ni reprise ni relance (cf. failedRegrade_backToReview).
            assertThat(quiz.getAllowRetry()).isFalse();
            assertThat(attempt.isRegrade()).isFalse();
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(null);
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(gradingFailureRepository.findById(new GradingFailure.Key(4, 3)))
                    .thenReturn(Optional.of(failures(3)));

            service.gradeAttempt(ATTEMPT_ID);

            assertThat(attempt.getStatus()).isEqualTo(QuizService.REVIEW);
            verify(attemptRepository, never()).delete(any(Attempt.class));
            verify(gradingFailureRepository, never()).save(any());
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, QuizService.REVIEW);
        }

        @Test
        @DisplayName("Quiz AVEC reprise, plafond atteint : une panne supprime (l'étudiant resoumet)")
        void capReached_withRetry_outageDeletes() {
            quiz.setAllowRetry(true);
            when(attemptRepository.findById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(executionClient.evaluate(any(), any(), any(), any(), any())).thenReturn(null);
            when(attemptRepository.findByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
            when(gradingFailureRepository.findById(new GradingFailure.Key(4, 3)))
                    .thenReturn(Optional.of(failures(3)));

            service.gradeAttempt(ATTEMPT_ID);

            verify(attemptRepository).delete(attempt);
            verify(realtimePublisher).quizAttemptFailed(3L, 4L, ATTEMPT_ID, null);
        }

        @Test
        @DisplayName("Quiz AVEC reprise : un échec SANS VERDICT au plafond garde quand même")
        void capReached_withRetry_noVerdictKeeps() {
            quiz.setAllowRetry(true);
            failsWithoutVerdict();
            when(gradingFailureRepository.findById(new GradingFailure.Key(4, 3)))
                    .thenReturn(Optional.of(failures(2)));

            service.gradeAttempt(ATTEMPT_ID);

            assertThat(attempt.getStatus()).isEqualTo(QuizService.REVIEW);
            verify(attemptRepository, never()).delete(any(Attempt.class));
        }
    }

    @Test
    @DisplayName("Plafond d'échecs sans verdict inférieur à 1 → refusé au démarrage")
    void capBelowOne_rejectedAtStartup() {
        // 0 ne désactive pas le plafond : il le rend toujours atteint (revue #246).
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.setMaxNoVerdictFailures(0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("au moins 1");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.setMaxNoVerdictFailures(-2))
                .isInstanceOf(IllegalArgumentException.class);
        service.setMaxNoVerdictFailures(1);
    }

    // ── getMyAttempts ───────────────────────────────────────────────────────────

    @Test
    @DisplayName("Historique : tentatives en correction ordinaire (pending) exclues, score recalculé et date en UTC")
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
    @DisplayName("Historique : une tentative à revoir y figure, sans note, avec son statut")
    void getMyAttempts_attemptToReview() {
        Question q = question(10, SINGLE, 2.0, 0);
        answer(q, 1, "ok", true);
        Quiz quiz = quiz(4, course(1), q);
        Attempt done = attempt(80, quiz, eva, 1, "done", submission(q, choice(10, 1)));
        Attempt review = attempt(81, quiz, eva, 2, QuizService.REVIEW, submission(q, choice(10, 1)));
        when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
        when(attemptRepository.findByQuiz_IdAndUser_IdOrderByAttemptNoAsc(4, 3))
                .thenReturn(List.of(done, review));

        List<AttemptSummaryDTO> history = service.getMyAttempts(4, EMAIL);

        assertThat(history).extracting(AttemptSummaryDTO::getStatus)
                .containsExactly("done", QuizService.REVIEW);
        assertThat(history.get(0).getEarned()).isEqualTo(2.0);
        // Aucun verdict n'existe : pas de note, mais le barème reste affichable.
        assertThat(history.get(1).getEarned()).isNull();
        assertThat(history.get(1).getMax()).isEqualTo(2.0);
    }

    // ── Tentatives à revoir (#116, S4) ──────────────────────────────────────────

    @Nested
    @DisplayName("Tentatives à revoir")
    class Review {

        private Quiz quiz;
        private Attempt review;

        @BeforeEach
        void setUp() {
            // Comme en vrai : une tentative n'est « à revoir » qu'après des échecs de harnais,
            // donc le quiz porte une question Code avec harnais (needsSandbox vrai).
            Question q = question(10, SINGLE, 2.0, 0);
            Question codeQ = question(11, CODE, 3.0, 1);
            codeQ.setLanguage(language(2, "python"));
            testCase(codeQ, 90, "cas", 1);
            quiz = quiz(4, course(1), q, codeQ);
            review = attempt(81, quiz, eva, 2, QuizService.REVIEW, submission(q, choice(10, 1)),
                    submission(codeQ, SubmittedAnswerDTO.builder().questionId(11).code("print(1)").build()));
            review.setSubmittedAt(LocalDateTime.of(2026, 9, 2, 8, 30));
        }

        @Test
        @DisplayName("Liste : nom de l'étudiant, date en UTC, nombre d'échecs sans verdict")
        void listsAttemptsToReview() {
            // Un autre étudiant, au prénom ET au nom distincts : chaque ligne porte le nom de
            // l'auteur de SA tentative, pas celui d'un autre.
            User bob = user(5, "bob@test.ca");
            bob.setFirstName("Bob");
            bob.setLastName("Martin");
            Attempt undated = attempt(82, quiz, bob, 1, QuizService.REVIEW);
            when(attemptRepository.findByQuiz_IdAndStatusOrderBySubmittedAtAscIdAsc(4, QuizService.REVIEW))
                    .thenReturn(List.of(review, undated));
            GradingFailure failure = new GradingFailure();
            failure.setNoVerdictCount(3);
            when(gradingFailureRepository.findById(new GradingFailure.Key(4, 3)))
                    .thenReturn(Optional.of(failure));

            assertThat(service.getAttemptsToReview(4)).containsExactly(
                    new ReviewAttemptDTO(81, 2, "Éva Test", Instant.parse("2026-09-02T08:30:00Z"), 3),
                    new ReviewAttemptDTO(82, 1, "Bob Martin", null, 0));
        }

        @Test
        @DisplayName("Relance : la tentative repasse en pending, part en correction, est journalisée")
        void regrade_backToPendingAndAudited() {
            when(attemptRepository.findByIdForUpdate(81)).thenReturn(Optional.of(review));

            service.regradeAttempt(4, 81);

            assertThat(review.getStatus()).isEqualTo("pending");
            // Marqueur de relance : un nouvel échec la remettra à revoir (cf. failGrading).
            assertThat(review.isRegrade()).isTrue();
            verify(attemptRepository).saveAndFlush(review);
            // Repart sur le pool du CODE : la question Code a des harnais à exécuter.
            verify(eventPublisher).publishEvent(new AttemptSubmittedEvent(81, true));
            ArgumentCaptor<String> summary = ArgumentCaptor.forClass(String.class);
            verify(auditLogService).record(eq("QUIZ_REGRADE"), eq("QUIZ"), eq(4), summary.capture(), any());
            assertThat(summary.getValue()).contains("tentative 2").contains("Éva Test").contains("Quiz 4");
        }

        @Test
        @DisplayName("Historique pendant une relance : la tentative reste « à revoir », une correction ordinaire en cours n'y est pas")
        void history_duringRegrade() {
            review.setStatus("pending");
            review.setRegrade(true);
            Attempt ordinaryPending = attempt(83, quiz, eva, 3, "pending");
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
            when(attemptRepository.findByQuiz_IdAndUser_IdOrderByAttemptNoAsc(4, 3))
                    .thenReturn(List.of(review, ordinaryPending));

            assertThat(service.getMyAttempts(4, EMAIL))
                    .singleElement()
                    .satisfies(a -> {
                        assertThat(a.getId()).isEqualTo(81);
                        assertThat(a.getStatus()).isEqualTo(QuizService.REVIEW);
                        assertThat(a.getEarned()).isNull();
                    });
        }

        @Test
        @DisplayName("Relance d'une tentative d'un AUTRE quiz ou inconnue → 404, rien ne change")
        void regrade_otherQuiz() {
            when(attemptRepository.findByIdForUpdate(81)).thenReturn(Optional.of(review));

            assertThatThrownBy(() -> service.regradeAttempt(5, 81))
                    .isInstanceOf(AttemptNotFoundException.class);
            assertThatThrownBy(() -> service.regradeAttempt(4, 99))
                    .isInstanceOf(AttemptNotFoundException.class);
            assertThat(review.getStatus()).isEqualTo(QuizService.REVIEW);
            verify(eventPublisher, never()).publishEvent(any());
        }

        @Test
        @DisplayName("Relance d'une tentative pas à revoir, ou correction déjà en cours → 409")
        void regrade_rejected() {
            review.setStatus("done");
            when(attemptRepository.findByIdForUpdate(81)).thenReturn(Optional.of(review));
            assertThatThrownBy(() -> service.regradeAttempt(4, 81))
                    .isInstanceOf(AttemptNotReviewableException.class);

            review.setStatus(QuizService.REVIEW);
            when(attemptRepository.saveAndFlush(review))
                    .thenThrow(new DataIntegrityViolationException("uq_attempt_pending"));
            assertThatThrownBy(() -> service.regradeAttempt(4, 81))
                    .isInstanceOf(AttemptNotReviewableException.class);
            verify(eventPublisher, never()).publishEvent(any());
        }
    }

    @Test
    @DisplayName("Historique d'un utilisateur inconnu → UserNotFoundException")
    void getMyAttempts_utilisateurInconnu() {
        when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getMyAttempts(4, EMAIL))
                .isInstanceOf(UserNotFoundException.class);
    }

    // ── getAttemptStatus ────────────────────────────────────────────────────────

    @Nested
    @DisplayName("getAttemptStatus : statut d'une tentative de l'étudiant sur ce quiz")
    class AttemptStatus {

        private Quiz quiz;

        @BeforeEach
        void setUp() {
            quiz = quiz(4, course(1), question(10, SINGLE, 1.0, 0));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
        }

        private String statusOf(Attempt attempt) {
            when(attemptRepository.findByIdAndUser_Id(attempt.getId(), 3)).thenReturn(Optional.of(attempt));
            return service.getAttemptStatus(4, attempt.getId(), EMAIL).getStatus();
        }

        @Test
        @DisplayName("pending, done, review : le statut de la tentative")
        void ownAttempt_returnsItsStatus() {
            assertThat(statusOf(attempt(70, quiz, eva, 1, "pending"))).isEqualTo("pending");
            assertThat(statusOf(attempt(71, quiz, eva, 2, "done"))).isEqualTo("done");
            assertThat(statusOf(attempt(72, quiz, eva, 3, QuizService.REVIEW))).isEqualTo("review");
        }

        @Test
        @DisplayName("Relance de l'enseignant en cours (pending marqué relance) → « review », comme l'historique")
        void regradeInProgress_isReview() {
            Attempt regraded = attempt(73, quiz, eva, 1, "pending");
            regraded.setRegrade(true);

            assertThat(statusOf(regraded)).isEqualTo(QuizService.REVIEW);
        }

        @Test
        @DisplayName("Absente ou supprimée (correction échouée), ou d'un autre étudiant → 404")
        void absentOrOtherStudent_notFound() {
            // La requête est restreinte à l'étudiant connecté : la tentative d'un autre n'y
            // apparaît pas, exactement comme une tentative supprimée.
            when(attemptRepository.findByIdAndUser_Id(74, 3)).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.getAttemptStatus(4, 74, EMAIL))
                    .isInstanceOf(AttemptNotFoundException.class);
            verify(attemptRepository).findByIdAndUser_Id(74, 3);
        }

        @Test
        @DisplayName("Tentative de l'étudiant sur un AUTRE quiz → 404 (pas de fuite d'existence)")
        void otherQuiz_notFound() {
            Attempt elsewhere = attempt(75, quiz(5, course(1), question(11, SINGLE, 1.0, 0)), eva, 1, "pending");
            when(attemptRepository.findByIdAndUser_Id(75, 3)).thenReturn(Optional.of(elsewhere));

            assertThatThrownBy(() -> service.getAttemptStatus(4, 75, EMAIL))
                    .isInstanceOf(AttemptNotFoundException.class);
        }

        @Test
        @DisplayName("Utilisateur inconnu → UserNotFoundException")
        void unknownUser_notFound() {
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.getAttemptStatus(4, 70, EMAIL))
                    .isInstanceOf(UserNotFoundException.class);
        }
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
        when(attemptRepository.findWithSubmissionsByCourseId(1))
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
        when(attemptRepository.findWithSubmissionsByCourseId(1)).thenReturn(List.of());

        CourseQuizStatsDTO stats = service.getCourseQuizStats(1);

        assertThat(stats.averageScorePercent()).isNull();
        assertThat(stats.gradedAttemptCount()).isZero();
        assertThat(stats.studentCount()).isZero();
    }
}
