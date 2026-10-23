package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.CodingTestResultDTO;
import com.moodit.core_service.dto.MatchingItemResultDTO;
import com.moodit.core_service.dto.QuestionResultDTO;
import com.moodit.core_service.dto.QuizResultDTO;
import com.moodit.core_service.dto.SubmittedAnswerDTO;
import com.moodit.core_service.exception.AttemptNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Attempt;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.Submission;
import com.moodit.core_service.model.TestCase;
import com.moodit.core_service.model.User;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * Correction des 6 types de question, observée via {@link QuizService#getAttemptResult} : la
 * tentative persistée (réponses sérialisées + verdicts de code) est re-corrigée à partir du quiz
 * COURANT. Chaque test fixe un barème et une réponse, puis vérifie le score et le détail renvoyé
 * au front (ids corrects / choisis, ordre attendu, placement, verdicts des harnais).
 */
class QuizServiceGradingTest extends QuizServiceTestSupport {

    private static final int ATTEMPT_ID = 7;
    private User eva;

    @BeforeEach
    void setUpUser() {
        eva = user(3, EMAIL);
    }

    /** Corrige une tentative composée des questions et soumissions données. */
    private QuizResultDTO grade(Quiz quiz, Submission... subs) {
        Attempt attempt = attempt(ATTEMPT_ID, quiz, eva, 2, "done", subs);
        when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
        when(attemptRepository.findByIdAndUser_Id(ATTEMPT_ID, 3)).thenReturn(Optional.of(attempt));
        return service.getAttemptResult(ATTEMPT_ID, EMAIL);
    }

    private QuestionResultDTO gradeSingle(Question q, SubmittedAnswerDTO answer) {
        QuizResultDTO result = grade(quiz(1, course(1), q), submission(q, answer));
        assertThat(result.getQuestions()).hasSize(1);
        return result.getQuestions().get(0);
    }

    // ── Choix unique / Vrai-Faux ────────────────────────────────────────────────

    @Nested
    @DisplayName("Choix unique et Vrai/Faux : tout ou rien")
    class SingleChoice {

        private Question q;

        @BeforeEach
        void setUp() {
            q = question(10, SINGLE, 4.0, 0);
            answer(q, 1, "Bonne", true);
            answer(q, 2, "Mauvaise", false);
        }

        @Test
        @DisplayName("Bonne option choisie → score plein et détail des ids")
        void bonneReponse_scorePlein() {
            QuestionResultDTO r = gradeSingle(q, choice(10, 1));

            assertThat(r.getQuestionId()).isEqualTo(10);
            assertThat(r.getEarned()).isEqualTo(4.0);
            assertThat(r.getMax()).isEqualTo(4.0);
            assertThat(r.getCorrectAnswerIds()).containsExactly(1);
            assertThat(r.getSelectedAnswerIds()).containsExactly(1);
        }

        @Test
        @DisplayName("Mauvaise option → 0")
        void mauvaiseReponse_zero() {
            QuestionResultDTO r = gradeSingle(q, choice(10, 2));

            assertThat(r.getEarned()).isZero();
            assertThat(r.getSelectedAnswerIds()).containsExactly(2);
        }

        @Test
        @DisplayName("Bonne ET mauvaise cochées → 0 (l'ensemble choisi doit être exact)")
        void deuxOptionsCochees_zero() {
            QuestionResultDTO r = gradeSingle(q, choice(10, 1, 2));

            assertThat(r.getEarned()).isZero();
        }

        @Test
        @DisplayName("Vrai/Faux suit la même règle exacte que le choix unique")
        void vraiFaux_memeRegle() {
            Question tf = question(11, TRUE_FALSE, 1.0, 0);
            answer(tf, 5, "Vrai", false);
            answer(tf, 6, "Faux", true);

            QuestionResultDTO r = gradeSingle(tf, choice(11, 6));

            assertThat(r.getEarned()).isEqualTo(1.0);
            assertThat(r.getCorrectAnswerIds()).containsExactly(6);
        }

        @Test
        @DisplayName("Question non répondue → sélection vide et 0")
        void sansReponse_zero() {
            QuestionResultDTO r = gradeSingle(q, null);

            assertThat(r.getSelectedAnswerIds()).isEmpty();
            assertThat(r.getEarned()).isZero();
            assertThat(r.getMax()).isEqualTo(4.0);
        }

        @Test
        @DisplayName("Contenu soumis illisible (JSON corrompu) → traité comme une réponse vide")
        void contenuIllisible_reponseVide() {
            Submission s = submission(q, null);
            s.setContent("{pas du json");

            QuizResultDTO result = grade(quiz(1, course(1), q), s);

            assertThat(result.getQuestions().get(0).getSelectedAnswerIds()).isEmpty();
            assertThat(result.getEarned()).isZero();
        }

        @Test
        @DisplayName("Réponse sérialisée sans questionId → rattachée à la question de la soumission")
        void reponseSansQuestionId_rattacheeALaQuestion() {
            Submission s = submission(q, null);
            s.setContent("{\"answerIds\":[1]}");

            QuizResultDTO result = grade(quiz(1, course(1), q), s);

            assertThat(result.getQuestions().get(0).getEarned()).isEqualTo(4.0);
        }
    }

    // ── Choix multiple ──────────────────────────────────────────────────────────

    @Nested
    @DisplayName("Choix multiple : (bonnes − mauvaises) / nb de bonnes, borné à [0, 1]")
    class MultipleChoice {

        private Question q;

        @BeforeEach
        void setUp() {
            q = question(20, MULTIPLE, 5.0, 0);
            answer(q, 1, "A", true);
            answer(q, 2, "B", true);
            answer(q, 3, "C", false);
        }

        @Test
        @DisplayName("Toutes les bonnes, aucune mauvaise → score plein")
        void toutesLesBonnes_scorePlein() {
            assertThat(gradeSingle(q, choice(20, 1, 2)).getEarned()).isEqualTo(5.0);
        }

        @Test
        @DisplayName("Une bonne sur deux → moitié du barème")
        void uneBonneSurDeux_moitie() {
            QuestionResultDTO r = gradeSingle(q, choice(20, 2));

            assertThat(r.getEarned()).isEqualTo(2.5);
            assertThat(r.getCorrectAnswerIds()).containsExactly(1, 2);
        }

        @Test
        @DisplayName("Une bonne et une mauvaise se compensent → 0")
        void bonneEtMauvaise_secompensent() {
            assertThat(gradeSingle(q, choice(20, 1, 3)).getEarned()).isZero();
        }

        @Test
        @DisplayName("Plus de mauvaises que de bonnes → borné à 0 (jamais négatif)")
        void plusDeMauvaises_borneAZero() {
            Question many = question(21, MULTIPLE, 5.0, 0);
            answer(many, 1, "A", true);
            answer(many, 2, "B", true);
            answer(many, 3, "C", false);
            answer(many, 4, "D", false);

            assertThat(gradeSingle(many, choice(21, 3, 4)).getEarned()).isZero();
        }

        @Test
        @DisplayName("Aucune option correcte définie → 0 (pas de division par zéro)")
        void aucuneOptionCorrecte_zero() {
            Question none = question(22, MULTIPLE, 5.0, 0);
            answer(none, 1, "A", false);

            assertThat(gradeSingle(none, choice(22, 1)).getEarned()).isZero();
        }

        @Test
        @Disabled("bogue : QuizService.gradeChoice (choix multiple) compte les ids sélectionnés en LISTE, "
                + "sans dédoublonner. Soumettre deux fois la même bonne option ([1, 1]) donne good = 2 "
                + "→ ratio 2/2 → score PLEIN alors qu'une seule des deux bonnes réponses est cochée. "
                + "Attendu : dédoublonner selectedIds (Set) avant le décompte → 2.5 / 5.")
        @DisplayName("Bogue : une même bonne option envoyée deux fois ne doit compter qu'une fois")
        void optionDupliquee_compteUneSeuleFois() {
            assertThat(gradeSingle(q, choice(20, 1, 1)).getEarned()).isEqualTo(2.5);
        }
    }

    // ── Remise en ordre ─────────────────────────────────────────────────────────

    @Nested
    @DisplayName("Remise en ordre : proportion d'éléments à la bonne position")
    class Ordering {

        private Question q;

        @BeforeEach
        void setUp() {
            q = question(30, ORDERING, 3.0, 0);
            drag(q, 100, "troisième", 2, null);
            drag(q, 101, "premier", 0, null);
            drag(q, 102, "deuxième", 1, null);
        }

        private SubmittedAnswerDTO order(Integer... ids) {
            return SubmittedAnswerDTO.builder().questionId(30).orderedItemIds(List.of(ids)).build();
        }

        @Test
        @DisplayName("Ordre exact → score plein, ordre attendu trié par correctOrder")
        void ordreExact_scorePlein() {
            QuestionResultDTO r = gradeSingle(q, order(101, 102, 100));

            assertThat(r.getEarned()).isEqualTo(3.0);
            assertThat(r.getCorrectOrder()).containsExactly(101, 102, 100);
            assertThat(r.getSubmittedOrder()).containsExactly(101, 102, 100);
        }

        @Test
        @DisplayName("Un seul élément bien placé sur trois → 1/3 du barème")
        void unSurTrois_tiers() {
            QuestionResultDTO r = gradeSingle(q, order(101, 100, 102));

            assertThat(r.getEarned()).isEqualTo(1.0);
        }

        @Test
        @DisplayName("Ordre soumis plus court que la liste → seules les positions fournies comptent")
        void ordreIncomplet_positionsFourniesSeulement() {
            QuestionResultDTO r = gradeSingle(q, order(101, 102));

            assertThat(r.getEarned()).isEqualTo(2.0);
        }

        @Test
        @DisplayName("Pas de réponse → ordre soumis vide et 0")
        void sansReponse_zero() {
            QuestionResultDTO r = gradeSingle(q, null);

            assertThat(r.getSubmittedOrder()).isEmpty();
            assertThat(r.getEarned()).isZero();
        }

        @Test
        @DisplayName("correctOrder absent → considéré comme 0 pour le tri")
        void correctOrderNull_traiteCommeZero() {
            Question q2 = question(31, ORDERING, 2.0, 0);
            drag(q2, 200, "b", 1, null);
            drag(q2, 201, "a", null, null);

            QuestionResultDTO r = gradeSingle(q2,
                    SubmittedAnswerDTO.builder().questionId(31).orderedItemIds(List.of(201, 200)).build());

            assertThat(r.getCorrectOrder()).containsExactly(201, 200);
            assertThat(r.getEarned()).isEqualTo(2.0);
        }

        @Test
        @DisplayName("Question sans élément → 0")
        void sansElement_zero() {
            Question empty = question(32, ORDERING, 2.0, 0);

            assertThat(gradeSingle(empty, null).getEarned()).isZero();
        }
    }

    // ── Association ─────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("Association : proportion d'éléments placés dans le bon groupe")
    class Matching {

        private Question q;

        @BeforeEach
        void setUp() {
            q = question(40, MATCHING, 2.0, 0);
            drag(q, 300, "Java", 0, "Objet");
            drag(q, 301, "Haskell", 0, "Fonctionnel");
        }

        private SubmittedAnswerDTO placement(Map<Integer, String> p) {
            return SubmittedAnswerDTO.builder().questionId(40).placement(p).build();
        }

        @Test
        @DisplayName("Un élément sur deux bien classé → moitié, détail par élément")
        void unSurDeux_moitieEtDetail() {
            QuestionResultDTO r = gradeSingle(q, placement(Map.of(300, "Objet", 301, "Objet")));

            assertThat(r.getEarned()).isEqualTo(1.0);
            assertThat(r.getMatching()).hasSize(2);
            MatchingItemResultDTO java = r.getMatching().get(0);
            assertThat(java.getItemId()).isEqualTo(300);
            assertThat(java.getChosenGroup()).isEqualTo("Objet");
            assertThat(java.getCorrectGroup()).isEqualTo("Objet");
            assertThat(java.getCorrect()).isTrue();
            MatchingItemResultDTO haskell = r.getMatching().get(1);
            assertThat(haskell.getChosenGroup()).isEqualTo("Objet");
            assertThat(haskell.getCorrectGroup()).isEqualTo("Fonctionnel");
            assertThat(haskell.getCorrect()).isFalse();
        }

        @Test
        @DisplayName("Tous bien classés → score plein")
        void tousBienClasses_scorePlein() {
            QuestionResultDTO r = gradeSingle(q, placement(Map.of(300, "Objet", 301, "Fonctionnel")));

            assertThat(r.getEarned()).isEqualTo(2.0);
        }

        @Test
        @DisplayName("Élément non classé → choix null, incorrect")
        void nonClasse_incorrect() {
            QuestionResultDTO r = gradeSingle(q, null);

            assertThat(r.getEarned()).isZero();
            assertThat(r.getMatching()).allSatisfy(m -> {
                assertThat(m.getChosenGroup()).isNull();
                assertThat(m.getCorrect()).isFalse();
            });
        }

        @Test
        @DisplayName("Groupe correct absent → chaîne vide attendue")
        void groupeAbsent_chaineVide() {
            Question q2 = question(41, MATCHING, 1.0, 0);
            drag(q2, 310, "x", 0, null);

            QuestionResultDTO r = gradeSingle(q2, null);

            assertThat(r.getMatching().get(0).getCorrectGroup()).isEmpty();
        }
    }

    // ── Code ────────────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("Code : score pondéré par les verdicts persistés des harnais")
    class Coding {

        private Question q;
        private TestCase light;
        private TestCase heavy;

        @BeforeEach
        void setUp() {
            q = question(50, CODE, 10.0, 0);
            light = testCase(q, 61, "cas simple", 1);
            heavy = testCase(q, 60, "cas lourd", 3);
        }

        private SubmittedAnswerDTO code(String src) {
            return SubmittedAnswerDTO.builder().questionId(50).code(src).build();
        }

        @Test
        @DisplayName("Harnais léger réussi, lourd échoué → poids 1/4 du barème, harnais triés par id")
        void verdictsPartiels_scorePondere() {
            Submission s = submission(q, code("print(1)"));
            verdict(s, light, true);
            verdict(s, heavy, false);

            QuestionResultDTO r = grade(quiz(1, course(1), q), s).getQuestions().get(0);

            assertThat(r.getEarned()).isEqualTo(2.5);
            assertThat(r.getMax()).isEqualTo(10.0);
            assertThat(r.getSubmittedCode()).isEqualTo("print(1)");
            assertThat(r.getTests()).containsExactly(
                    new CodingTestResultDTO("cas lourd", false, 3),
                    new CodingTestResultDTO("cas simple", true, 1));
        }

        @Test
        @DisplayName("Aucun verdict persisté → « en cours » : tests null, 0 point, code conservé")
        void sansVerdict_enCours() {
            QuestionResultDTO r = gradeSingle(q, code("print(2)"));

            assertThat(r.getTests()).isNull();
            assertThat(r.getEarned()).isZero();
            assertThat(r.getMax()).isEqualTo(10.0);
            assertThat(r.getSubmittedCode()).isEqualTo("print(2)");
        }

        @Test
        @DisplayName("Question Code non répondue → code soumis null")
        void sansReponse_codeNull() {
            QuestionResultDTO r = gradeSingle(q, null);

            assertThat(r.getSubmittedCode()).isNull();
            assertThat(r.getTests()).isNull();
        }
    }

    // ── Agrégat de la tentative ─────────────────────────────────────────────────

    @Test
    @DisplayName("Type de question inconnu → résultat « en cours » (0 / barème)")
    void typeInconnu_enCours() {
        Question unknown = question(70, null, 3.0, 0);

        QuestionResultDTO r = gradeSingle(unknown, null);

        assertThat(r.getEarned()).isZero();
        assertThat(r.getMax()).isEqualTo(3.0);
        assertThat(r.getTests()).isNull();
    }

    @Test
    @DisplayName("Total : somme des questions COURANTES triées, question ajoutée après coup = 0 / barème")
    void total_questionsCourantes_triees() {
        Question second = question(81, SINGLE, 2.0, 1);
        answer(second, 11, "ok", true);
        Question first = question(80, SINGLE, 1.5, 0);
        answer(first, 10, "ok", true);
        // Question ajoutée APRÈS la tentative : aucune soumission → comptée au barème, 0 point.
        Question added = question(82, SINGLE, 4.0, 2);
        answer(added, 12, "ok", true);
        Quiz quiz = quiz(9, course(1), second, added, first);

        QuizResultDTO result = grade(quiz,
                submission(first, choice(80, 10)), submission(second, choice(81, 11)));

        assertThat(result.getQuizId()).isEqualTo(9);
        assertThat(result.getAttemptId()).isEqualTo(ATTEMPT_ID);
        assertThat(result.getAttemptNo()).isEqualTo(2);
        assertThat(result.getEarned()).isEqualTo(3.5);
        assertThat(result.getMax()).isEqualTo(7.5);
        assertThat(result.getQuestions()).extracting(QuestionResultDTO::getQuestionId)
                .containsExactly(80, 81, 82);
    }

    @Test
    @DisplayName("Tentative sans soumission (liste null) → tout à 0")
    void tentativeSansSoumission_zero() {
        Question q = question(90, SINGLE, 2.0, 0);
        answer(q, 1, "ok", true);
        Attempt attempt = attempt(ATTEMPT_ID, quiz(1, course(1), q), eva, 1, "done");
        attempt.setSubmissions(null);
        when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
        when(attemptRepository.findByIdAndUser_Id(ATTEMPT_ID, 3)).thenReturn(Optional.of(attempt));

        QuizResultDTO result = service.getAttemptResult(ATTEMPT_ID, EMAIL);

        assertThat(result.getEarned()).isZero();
        assertThat(result.getMax()).isEqualTo(2.0);
    }

    @Test
    @DisplayName("Utilisateur inconnu → UserNotFoundException")
    void utilisateurInconnu_404() {
        when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getAttemptResult(ATTEMPT_ID, EMAIL))
                .isInstanceOf(UserNotFoundException.class);
    }

    @Test
    @DisplayName("Tentative d'un autre utilisateur (ou inexistante) → AttemptNotFoundException")
    void tentativeDunAutre_404() {
        when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(eva));
        when(attemptRepository.findByIdAndUser_Id(ATTEMPT_ID, 3)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getAttemptResult(ATTEMPT_ID, EMAIL))
                .isInstanceOf(AttemptNotFoundException.class);
    }
}
