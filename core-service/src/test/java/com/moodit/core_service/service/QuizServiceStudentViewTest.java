package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.DragItemDTO;
import com.moodit.core_service.dto.QuestionDTO;
import com.moodit.core_service.dto.QuestionResultDTO;
import com.moodit.core_service.dto.QuizDetailDTO;
import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.dto.QuizSubmissionDTO;
import com.moodit.core_service.dto.SubmittedAnswerDTO;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.model.Attempt;
import com.moodit.core_service.model.DragItem;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.Submission;
import com.moodit.core_service.model.User;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Vue PASSATION d'un quiz (#28) : un brouillon n'est ni lisible ni soumissible par ce chemin, les
 * éléments déplaçables arrivent mélangés avec des ids publics non corrélés à la solution, aucune
 * information de correction n'est exposée, et la correction reste juste après le mélange.
 */
class QuizServiceStudentViewTest extends QuizServiceTestSupport {

    private User eva;

    @BeforeEach
    void setUpUser() {
        eva = user(3, EMAIL);
    }

    private static QuizSubmissionDTO body(int quizId, SubmittedAnswerDTO... answers) {
        return QuizSubmissionDTO.builder().quizId(quizId).answers(List.of(answers)).build();
    }

    /** Remise en ordre de n éléments, ids 100.. créés DANS l'ordre attendu (comme l'éditeur). */
    private static Question orderingQuestion(int id, int size) {
        Question q = question(id, ORDERING, size, 0);
        for (int i = 0; i < size; i++) {
            drag(q, 100 + i, "élément " + i, i, null);
        }
        return q;
    }

    // ── Brouillons ──────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("Quiz non publié : absent du chemin de passation")
    class Drafts {

        private Quiz draft;

        @BeforeEach
        void setUp() {
            draft = quiz(4, course(1), orderingQuestion(30, 3));
            draft.setIsPublished(false);
            when(quizRepository.findById(4)).thenReturn(Optional.of(draft));
        }

        @Test
        @DisplayName("Lecture d'un brouillon en passation → 404")
        void lectureBrouillon_404() {
            assertThatThrownBy(() -> service.getQuizDetail(4)).isInstanceOf(QuizNotFoundException.class);
        }

        @Test
        @DisplayName("Publication absente (null) → traitée comme un brouillon")
        void publicationNulle_404() {
            draft.setIsPublished(null);
            assertThatThrownBy(() -> service.getQuizDetail(4)).isInstanceOf(QuizNotFoundException.class);
        }

        @Test
        @DisplayName("Soumission d'un brouillon → 404, tentative non consommée")
        void soumissionBrouillon_404_rienEnregistre() {
            assertThatThrownBy(() -> service.submitQuiz(4, body(4), EMAIL))
                    .isInstanceOf(QuizNotFoundException.class);
            verify(attemptRepository, never()).saveAndFlush(any());
            verifyNoInteractions(submissionRepository, eventPublisher);
        }

        @Test
        @DisplayName("Vue éditeur d'un brouillon → toujours disponible (chemin du personnel)")
        void vueEditeurBrouillon_disponible() {
            QuizDetailDTO dto = service.getQuizForEdit(4);
            assertThat(dto.getIsPublished()).isFalse();
            assertThat(dto.getQuestions().get(0).getDragItems())
                    .extracting(DragItemDTO::getId).containsExactly(100, 101, 102);
            assertThat(dto.getQuestions().get(0).getDragItems())
                    .extracting(DragItemDTO::getCorrectOrder).containsExactly(0, 1, 2);
        }
    }

    // ── Aucune information de correction ────────────────────────────────────────

    @Test
    @DisplayName("Passation : ni isCorrect, ni correctOrder, ni groupe d'élément, ni harnais, ni id réel")
    void passation_sansInformationDeCorrection() {
        Question single = question(10, SINGLE, 1.0, 0);
        answer(single, 1, "A", true);
        answer(single, 2, "B", false);
        Question ordering = orderingQuestion(11, 4);
        ordering.setOrderIndex(1);
        Question matching = question(12, MATCHING, 2.0, 2);
        drag(matching, 300, "Java", 0, "Objet");
        drag(matching, 301, "Haskell", 0, "Fonctionnel");
        Question code = question(13, CODE, 2.0, 3);
        testCase(code, 1, "t1", 1);
        when(quizRepository.findById(4)).thenReturn(Optional.of(
                quiz(4, course(1), single, ordering, matching, code)));

        QuizDetailDTO dto = service.getQuizDetail(4);

        for (QuestionDTO q : dto.getQuestions()) {
            assertThat(q.getAnswers()).allSatisfy(a -> assertThat(a.getIsCorrect()).isNull());
            assertThat(q.getDragItems()).allSatisfy(d -> {
                assertThat(d.getCorrectOrder()).isNull();
                assertThat(d.getGroupName()).isNull();
            });
            assertThat(q.getTestCases()).isNull();
        }
        Set<Integer> realIds = Set.of(100, 101, 102, 103, 300, 301);
        List<Integer> sentIds = dto.getQuestions().stream()
                .flatMap(q -> q.getDragItems().stream()).map(DragItemDTO::getId).toList();
        assertThat(sentIds).hasSize(6).doesNotContainAnyElementsOf(realIds);
        // Les zones d'une association restent exposées (triées), pas le groupe de chaque élément.
        assertThat(dto.getQuestions().get(2).getGroups()).containsExactly("Fonctionnel", "Objet");
    }

    // ── Mélange et décorrélation ────────────────────────────────────────────────

    @Nested
    @DisplayName("Remise en ordre : ordre reçu non corrélé à correctOrder")
    class Shuffle {

        @Test
        @DisplayName("Sur 3000 envois, chaque élément occupe chaque position ~1/n des fois, ordres variés")
        void ordreRecu_uniformeEtVarie() {
            int size = 5;
            int draws = 3000;
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz(4, course(1), orderingQuestion(30, size))));
            Map<Integer, Integer> correctOrderByPublicId = new HashMap<>();
            for (int i = 0; i < size; i++) correctOrderByPublicId.put(pub(100 + i), i);

            int[][] counts = new int[size][size]; // [correctOrder][position reçue]
            Set<List<Integer>> distinctOrders = new HashSet<>();
            for (int draw = 0; draw < draws; draw++) {
                List<Integer> ids = service.getQuizDetail(4).getQuestions().get(0).getDragItems().stream()
                        .map(DragItemDTO::getId).toList();
                distinctOrders.add(ids);
                for (int pos = 0; pos < size; pos++) {
                    counts[correctOrderByPublicId.get(ids.get(pos))][pos]++;
                }
            }

            // Attendu : 600 par case. Tolérance large (±20 %) : test déterministe (graine fixée).
            double expected = (double) draws / size;
            for (int[] row : counts) {
                for (int c : row) {
                    assertThat((double) c).isBetween(expected * 0.8, expected * 1.2);
                }
            }
            assertThat(distinctOrders).hasSizeGreaterThan(100); // 120 permutations possibles
        }

        @Test
        @DisplayName("Trier les ids publics ne redonne pas l'ordre attendu (corrélation de rang faible)")
        void idsPublics_nonCorrelesAuxPositions() {
            int size = 60;
            Question q = orderingQuestion(30, size);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz(4, course(1), q)));
            Map<Integer, Integer> correctOrderByPublicId = new HashMap<>();
            for (DragItem d : q.getDragItems()) correctOrderByPublicId.put(pub(d.getId()), d.getCorrectOrder());

            List<Integer> byPublicId = service.getQuizDetail(4).getQuestions().get(0).getDragItems().stream()
                    .map(DragItemDTO::getId).sorted()
                    .map(correctOrderByPublicId::get).toList();

            // Spearman entre le rang de l'id public et correctOrder : ≈ 0 attendu, 1 = fuite totale.
            double sumSq = 0;
            for (int rank = 0; rank < size; rank++) {
                double diff = rank - byPublicId.get(rank);
                sumSq += diff * diff;
            }
            double rho = 1 - 6 * sumSq / (size * ((double) size * size - 1));
            assertThat(Math.abs(rho)).isLessThan(0.35);
        }

        @Test
        @DisplayName("Ids publics stables d'un envoi à l'autre (réponse en cours conservée au rechargement)")
        void idsPublics_stables() {
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz(4, course(1), orderingQuestion(30, 4))));
            Set<Integer> first = service.getQuizDetail(4).getQuestions().get(0).getDragItems().stream()
                    .map(DragItemDTO::getId).collect(Collectors.toSet());
            Set<Integer> second = service.getQuizDetail(4).getQuestions().get(0).getDragItems().stream()
                    .map(DragItemDTO::getId).collect(Collectors.toSet());
            assertThat(second).isEqualTo(first).containsExactlyInAnyOrder(pub(100), pub(101), pub(102), pub(103));
        }
    }

    // ── La correction reste juste après le mélange ──────────────────────────────

    @Nested
    @DisplayName("Aller-retour passation → soumission → correction")
    class RoundTrip {

        private Question ordering;
        private Question matching;
        private Quiz quiz;

        @BeforeEach
        void setUp() {
            ordering = orderingQuestion(30, 4);
            matching = question(40, MATCHING, 2.0, 1);
            drag(matching, 300, "Java", 0, "Objet");
            drag(matching, 301, "Haskell", 0, "Fonctionnel");
            quiz = quiz(4, course(1), ordering, matching);
            when(quizRepository.findById(4)).thenReturn(Optional.of(quiz));
            when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
        }

        /** Soumet `answers`, puis relit le résultat corrigé de la tentative persistée. */
        private QuizResultDTO submitThenGrade(SubmittedAnswerDTO... answers) {
            when(attemptRepository.saveAndFlush(any(Attempt.class))).thenAnswer(inv -> inv.getArgument(0));
            service.submitQuiz(4, body(4, answers), EMAIL);
            ArgumentCaptor<Submission> captor = ArgumentCaptor.forClass(Submission.class);
            verify(submissionRepository, org.mockito.Mockito.atLeastOnce()).save(captor.capture());
            List<Submission> saved = new ArrayList<>(captor.getAllValues());
            saved.forEach(s -> s.setTestCaseResults(new ArrayList<>()));
            Attempt attempt = attempt(7, quiz, eva, 1, "done", saved.toArray(Submission[]::new));
            when(attemptRepository.findByIdAndUser_Id(7, 3)).thenReturn(Optional.of(attempt));
            return service.getAttemptResult(7, EMAIL);
        }

        @Test
        @DisplayName("Ordre remis juste depuis la vue mélangée → score plein ; ids réels stockés")
        void ordreJuste_scorePlein() throws Exception {
            // L'étudiant remet les éléments dans l'ordre (il les reconnaît à leur contenu).
            List<Integer> answer = service.getQuizDetail(4).getQuestions().get(0).getDragItems().stream()
                    .sorted(Comparator.comparing(DragItemDTO::getContent))
                    .map(DragItemDTO::getId).toList();

            QuizResultDTO result = submitThenGrade(SubmittedAnswerDTO.builder()
                    .questionId(30).orderedItemIds(answer).build());

            QuestionResultDTO r = result.getQuestions().get(0);
            assertThat(r.getEarned()).isEqualTo(4.0);
            assertThat(r.getCorrectOrder()).isEqualTo(answer);
            assertThat(r.getSubmittedOrder()).isEqualTo(answer);
            ArgumentCaptor<Submission> captor = ArgumentCaptor.forClass(Submission.class);
            verify(submissionRepository, org.mockito.Mockito.atLeastOnce()).save(captor.capture());
            SubmittedAnswerDTO stored = objectMapper.readValue(
                    captor.getAllValues().get(0).getContent(), SubmittedAnswerDTO.class);
            assertThat(stored.getOrderedItemIds()).containsExactly(100, 101, 102, 103);
        }

        @Test
        @DisplayName("Ordre partiellement faux → score proportionnel, comme avant le mélange")
        void ordrePartiel_proportionnel() {
            QuizResultDTO result = submitThenGrade(SubmittedAnswerDTO.builder().questionId(30)
                    .orderedItemIds(List.of(pub(100), pub(101), pub(103), pub(102))).build());

            assertThat(result.getQuestions().get(0).getEarned()).isEqualTo(2.0);
        }

        @Test
        @DisplayName("Ordre en ids RÉELS (non publics) → refusé comme un ordre mal formé")
        void idsReels_refuses() {
            assertThatThrownBy(() -> service.submitQuiz(4, body(4, SubmittedAnswerDTO.builder()
                    .questionId(30).orderedItemIds(List.of(100, 101, 102, 103)).build()), EMAIL))
                    .isInstanceOf(com.moodit.core_service.exception.InvalidQuizException.class);
            verify(attemptRepository, never()).saveAndFlush(any());
        }

        @Test
        @DisplayName("Association : placement en ids publics corrigé ; id inconnu ignoré")
        void association_placementPublic() {
            Map<Integer, String> placement = new HashMap<>();
            placement.put(pub(300), "Objet");
            placement.put(pub(301), "Fonctionnel");
            placement.put(0, "Objet"); // hors domaine public → ignoré

            QuizResultDTO result = submitThenGrade(SubmittedAnswerDTO.builder()
                    .questionId(40).placement(placement).build());

            QuestionResultDTO r = result.getQuestions().get(1);
            assertThat(r.getEarned()).isEqualTo(2.0);
            assertThat(r.getMatching()).extracting(m -> m.getItemId())
                    .containsExactlyInAnyOrder(pub(300), pub(301));
        }

        @Test
        @DisplayName("Champs hors éléments déplaçables (choix, code) transmis tels quels")
        void autresChamps_inchanges() throws Exception {
            when(attemptRepository.saveAndFlush(any(Attempt.class))).thenAnswer(inv -> inv.getArgument(0));

            service.submitQuiz(4, body(4, SubmittedAnswerDTO.builder()
                    .questionId(40).answerIds(List.of(7)).code("print(1)").build()), EMAIL);

            ArgumentCaptor<Submission> captor = ArgumentCaptor.forClass(Submission.class);
            verify(submissionRepository, org.mockito.Mockito.times(2)).save(captor.capture());
            SubmittedAnswerDTO stored = objectMapper.readValue(
                    captor.getAllValues().get(1).getContent(), SubmittedAnswerDTO.class);
            assertThat(stored.getQuestionId()).isEqualTo(40);
            assertThat(stored.getAnswerIds()).containsExactly(7);
            assertThat(stored.getCode()).isEqualTo("print(1)");
            assertThat(stored.getOrderedItemIds()).isNull();
            assertThat(stored.getPlacement()).isNull();
        }
    }
}
