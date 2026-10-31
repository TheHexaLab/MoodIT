package com.moodit.core_service.service;

import com.moodit.core_service.exception.InvalidQuizException;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.AnswerDTO;
import com.moodit.core_service.dto.DragItemDTO;
import com.moodit.core_service.dto.LanguageDTO;
import com.moodit.core_service.dto.QuestionDTO;
import com.moodit.core_service.dto.QuestionTypeDTO;
import com.moodit.core_service.dto.QuizDTO;
import com.moodit.core_service.dto.QuizDetailDTO;
import com.moodit.core_service.dto.TestCaseDTO;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.model.Answer;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.DragItem;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.TestCase;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Lecture (catalogues, liste, passation vs éditeur) et écriture (création, mise à jour en place,
 * suppression, réordonnancement) des quiz par {@link QuizService}. On vérifie en particulier :
 * le masquage de la correction en passation, la réutilisation des entités existantes à la mise à
 * jour (ids stables → soumissions préservées), le journal d'audit et les diffusions temps réel
 * (immédiates hors transaction, différées après commit sinon).
 */
class QuizServiceEditorTest extends QuizServiceTestSupport {

    private static final String DETAILS = "Cours : Algo (IFT1)\nProgrammes : Génie info, Info";

    private Course course;

    @BeforeEach
    void setUpCourse() {
        course = course(1, program(11, "Génie info"), program(12, "Info"));
    }

    // ── Catalogues ──────────────────────────────────────────────────────────────

    @Test
    @DisplayName("Types de question triés par id, avec slug front et libellé FR")
    void getQuestionTypes_triesAvecSlug() {
        when(qTypeRepository.findAll()).thenReturn(List.of(
                type(6, CODE), type(1, TRUE_FALSE), type(3, MULTIPLE), type(9, "Inconnu")));

        List<QuestionTypeDTO> types = service.getQuestionTypes();

        assertThat(types).extracting(QuestionTypeDTO::getId).containsExactly(1, 3, 6, 9);
        assertThat(types).extracting(QuestionTypeDTO::getSlug)
                .containsExactly("true_false", "multiple_choice", "coding", null);
        assertThat(types.get(0).getLabel()).isEqualTo(TRUE_FALSE);
    }

    @Test
    @DisplayName("Langages complets (templates inclus) triés par id")
    void getLanguages_completsEtTries() {
        when(languageRepository.findAll()).thenReturn(List.of(language(5, "java"), language(2, "python")));

        List<LanguageDTO> languages = service.getLanguages();

        assertThat(languages).extracting(LanguageDTO::getName).containsExactly("python", "java");
        LanguageDTO python = languages.get(0);
        assertThat(python.getId()).isEqualTo(2);
        assertThat(python.getHarnessTemplate()).isEqualTo("harness-python");
        assertThat(python.getStartCodeTemplate()).isEqualTo("start-python");
        assertThat(python.getHarnessLanguageId()).isEqualTo(1002);
    }

    // ── listQuizzes ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("Liste publiée : brouillons exclus, tri par position (null en dernier), méta seule")
    void listQuizzes_publiesTriesParPosition() {
        Quiz third = quiz(3, course, question(1, SINGLE, 1, 0), question(2, SINGLE, 1, 1));
        third.setPosition(null);
        Quiz first = quiz(1, course);
        first.setPosition(0);
        Quiz draft = quiz(2, course);
        draft.setIsPublished(false);
        draft.setPosition(1);
        Quiz second = quiz(4, course);
        second.setPosition(2);
        second.setQuestions(null);
        course.getQuizzes().addAll(List.of(third, draft, second, first));
        when(courseRepository.findById(1)).thenReturn(Optional.of(course));

        List<QuizDTO> published = service.listQuizzes(1, true);

        assertThat(published).extracting(QuizDTO::getId).containsExactly(1, 4, 3);
        assertThat(published.get(2).getQuestionCount()).isEqualTo(2);
        assertThat(published.get(1).getQuestionCount()).isZero();
        assertThat(published.get(0).getTitle()).isEqualTo("Quiz 1");
        assertThat(published.get(0).getCreatedAt()).isEqualTo(first.getCreatedAt());
    }

    @Test
    @DisplayName("Vue éditeur (publishedOnly=false) : brouillons inclus")
    void listQuizzes_vueEditeur_inclutBrouillons() {
        Quiz draft = quiz(2, course);
        draft.setIsPublished(false);
        course.getQuizzes().add(draft);
        when(courseRepository.findById(1)).thenReturn(Optional.of(course));

        assertThat(service.listQuizzes(1, false)).extracting(QuizDTO::getId).containsExactly(2);
        assertThat(service.listQuizzes(1, true)).isEmpty();
    }

    @Test
    @DisplayName("Cours sans collection de quiz (null) → liste vide")
    void listQuizzes_collectionNull_vide() {
        course.setQuizzes(null);
        when(courseRepository.findById(1)).thenReturn(Optional.of(course));

        assertThat(service.listQuizzes(1, false)).isEmpty();
    }

    // ── Détail : passation vs éditeur ───────────────────────────────────────────

    private Quiz richQuiz() {
        Question code = question(20, CODE, 5.0, 1);
        code.setLanguage(language(2, "python"));
        code.setStartCode("def f():");
        testCase(code, 30, "cas", 2);
        Question match = question(21, MATCHING, 2.0, 0);
        drag(match, 40, "Java", 1, "Objet");
        drag(match, 41, "Haskell", 2, "Fonctionnel");
        answer(match, 50, "inutile", true);
        return quiz(9, course, code, match);
    }

    @Test
    @DisplayName("Passation : correction et harnais masqués, langage light, groupes exposés triés")
    void getQuizDetail_masqueLaCorrection() {
        when(quizRepository.findById(9)).thenReturn(Optional.of(richQuiz()));

        QuizDetailDTO detail = service.getQuizDetail(9);

        assertThat(detail.getId()).isEqualTo(9);
        assertThat(detail.getQuestions()).extracting(QuestionDTO::getId).containsExactly(21, 20);
        QuestionDTO match = detail.getQuestions().get(0);
        assertThat(match.getQType()).isEqualTo("matching");
        assertThat(match.getQTypeId()).isEqualTo(2100);
        assertThat(match.getGroups()).containsExactly("Fonctionnel", "Objet");
        assertThat(match.getDragItems()).allSatisfy(d -> {
            assertThat(d.getCorrectOrder()).isNull();
            assertThat(d.getGroupName()).isNull();
        });
        assertThat(match.getAnswers()).singleElement()
                .satisfies(a -> assertThat(a.getIsCorrect()).isNull());
        QuestionDTO code = detail.getQuestions().get(1);
        assertThat(code.getTestCases()).isNull();
        assertThat(code.getStartCode()).isEqualTo("def f():");
        assertThat(code.getLanguage().getName()).isEqualTo("python");
        assertThat(code.getLanguage().getHarnessTemplate()).isNull();
    }

    @Test
    @DisplayName("Passation d'un quiz introuvable → QuizNotFoundException")
    void getQuizDetail_introuvable() {
        when(quizRepository.findById(9)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getQuizDetail(9)).isInstanceOf(QuizNotFoundException.class);
    }

    @Test
    @DisplayName("Éditeur : correction et harnais inclus")
    void getQuizForEdit_inclutLaCorrection() {
        when(quizRepository.findById(9)).thenReturn(Optional.of(richQuiz()));

        QuizDetailDTO detail = service.getQuizForEdit(9);

        QuestionDTO match = detail.getQuestions().get(0);
        assertThat(match.getDragItems()).extracting(DragItemDTO::getGroupName).containsExactly("Objet", "Fonctionnel");
        assertThat(match.getDragItems()).extracting(DragItemDTO::getCorrectOrder).containsExactly(1, 2);
        assertThat(match.getAnswers().get(0).getIsCorrect()).isTrue();
        QuestionDTO code = detail.getQuestions().get(1);
        assertThat(code.getTestCases()).singleElement().satisfies(tc -> {
            assertThat(tc.getId()).isEqualTo(30);
            assertThat(tc.getName()).isEqualTo("cas");
            assertThat(tc.getHarnessCode()).isEqualTo("assert cas");
            assertThat(tc.getWeight()).isEqualTo(2);
        });
    }

    @Test
    @DisplayName("Question sans type ni collections → slug null et listes vides")
    void detail_questionMinimale() {
        Question bare = new Question();
        bare.setId(1);
        Quiz q = quiz(9, course, bare);
        when(quizRepository.findById(9)).thenReturn(Optional.of(q));

        QuestionDTO dto = service.getQuizForEdit(9).getQuestions().get(0);

        assertThat(dto.getQType()).isNull();
        assertThat(dto.getQTypeId()).isNull();
        assertThat(dto.getLanguage()).isNull();
        assertThat(dto.getAnswers()).isEmpty();
        assertThat(dto.getDragItems()).isEmpty();
        assertThat(dto.getGroups()).isEmpty();
        assertThat(dto.getTestCases()).isNull();
    }

    // ── createQuiz ──────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("createQuiz")
    class Create {

        @org.junit.jupiter.params.ParameterizedTest(name = "{0}")
        @org.junit.jupiter.params.provider.ValueSource(strings = {"true_false", "single_choice", "multiple_choice"})
        @DisplayName("Question à choix sans aucune bonne réponse → refusée, rien n'est enregistré")
        void choixSansBonneReponse_refuse(String slug) {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            String name = switch (slug) {
                case "true_false" -> TRUE_FALSE;
                case "single_choice" -> SINGLE;
                default -> MULTIPLE;
            };
            when(qTypeRepository.findByName(name)).thenReturn(Optional.of(type(1, name)));
            QuestionDTO bonne = QuestionDTO.builder().qType("matching").build();
            QuestionDTO sansBonne = QuestionDTO.builder().qType(slug)
                    .answers(List.of(
                            AnswerDTO.builder().content("A").isCorrect(false).build(),
                            AnswerDTO.builder().content("B").build()))
                    .build();
            when(qTypeRepository.findByName(MATCHING)).thenReturn(Optional.of(type(5, MATCHING)));

            assertThatThrownBy(() -> service.createQuiz(1, QuizDetailDTO.builder().title("T")
                    .questions(List.of(bonne, sansBonne)).build()))
                    .isInstanceOf(InvalidQuizException.class)
                    .hasMessage("Question 2 : au moins une bonne réponse doit être cochée.");
            verify(quizRepository, never()).save(any());
        }

        @Test
        @DisplayName("Question à choix avec au moins une bonne réponse → acceptée")
        void choixAvecBonneReponse_accepte() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(MULTIPLE)).thenReturn(Optional.of(type(3, MULTIPLE)));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));

            service.createQuiz(1, QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().qType("multiple_choice")
                            .answers(List.of(
                                    AnswerDTO.builder().content("A").isCorrect(true).build(),
                                    AnswerDTO.builder().content("B").isCorrect(false).build()))
                            .build()))
                    .build());

            verify(quizRepository).save(any(Quiz.class));
        }

        /** Remise en ordre (2e question du quiz) dont les éléments portent ces correctOrder. */
        private QuizDetailDTO orderingQuiz(Integer... orders) {
            List<DragItemDTO> items = new java.util.ArrayList<>();
            for (int i = 0; i < orders.length; i++) {
                items.add(DragItemDTO.builder().content("e" + i).correctOrder(orders[i]).build());
            }
            QuestionDTO premiere = QuestionDTO.builder().qType("multiple_choice")
                    .answers(List.of(AnswerDTO.builder().content("A").isCorrect(true).build())).build();
            return QuizDetailDTO.builder().title("T").questions(List.of(premiere,
                    QuestionDTO.builder().qType("ordering").dragItems(items).build())).build();
        }

        @org.junit.jupiter.params.ParameterizedTest(name = "{0}")
        @org.junit.jupiter.params.provider.ValueSource(strings = {"0,1,1", "2,2,2", "0,,1", ",,"})
        @DisplayName("Remise en ordre aux correctOrder répétés ou absents → refusée, rien n'est enregistré")
        void remiseEnOrdre_correctOrderRepeteOuAbsent_refuse(String csv) {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(MULTIPLE)).thenReturn(Optional.of(type(3, MULTIPLE)));
            when(qTypeRepository.findByName(ORDERING)).thenReturn(Optional.of(type(4, ORDERING)));
            Integer[] orders = java.util.Arrays.stream(csv.split(",", -1))
                    .map(v -> v.isEmpty() ? null : Integer.valueOf(v)).toArray(Integer[]::new);

            assertThatThrownBy(() -> service.createQuiz(1, orderingQuiz(orders)))
                    .isInstanceOf(InvalidQuizException.class)
                    .hasMessage("Question 2 : chaque élément doit avoir une position distincte dans l'ordre attendu.");
            verify(quizRepository, never()).save(any());
        }

        @org.junit.jupiter.params.ParameterizedTest(name = "{0} élément(s)")
        @org.junit.jupiter.params.provider.ValueSource(ints = {0, 1, 2})
        @DisplayName("Remise en ordre de moins de trois éléments → refusée, rien n'est enregistré")
        void remiseEnOrdre_moinsDeTroisElements_refuse(int size) {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(MULTIPLE)).thenReturn(Optional.of(type(3, MULTIPLE)));
            when(qTypeRepository.findByName(ORDERING)).thenReturn(Optional.of(type(4, ORDERING)));
            Integer[] orders = java.util.stream.IntStream.range(0, size).boxed().toArray(Integer[]::new);

            assertThatThrownBy(() -> service.createQuiz(1, orderingQuiz(orders)))
                    .isInstanceOf(InvalidQuizException.class)
                    .hasMessage("Question 2 : une remise en ordre doit avoir au moins 3 éléments.");
            verify(quizRepository, never()).save(any());
        }

        @Test
        @DisplayName("Remise en ordre sans liste d'éléments (absente du DTO) → refusée")
        void remiseEnOrdre_sansElements_refuse() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(ORDERING)).thenReturn(Optional.of(type(4, ORDERING)));

            assertThatThrownBy(() -> service.createQuiz(1, QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().qType("ordering").build())).build()))
                    .isInstanceOf(InvalidQuizException.class)
                    .hasMessage("Question 1 : une remise en ordre doit avoir au moins 3 éléments.");
            verify(quizRepository, never()).save(any());
        }

        @Test
        @DisplayName("Remise en ordre aux correctOrder 0..n-1 distincts (comme l'éditeur) → acceptée telle quelle")
        void remiseEnOrdre_correctOrderDistincts_accepte() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(MULTIPLE)).thenReturn(Optional.of(type(3, MULTIPLE)));
            when(qTypeRepository.findByName(ORDERING)).thenReturn(Optional.of(type(4, ORDERING)));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));

            service.createQuiz(1, orderingQuiz(2, 0, 1));

            ArgumentCaptor<Quiz> captor = ArgumentCaptor.forClass(Quiz.class);
            verify(quizRepository).save(captor.capture());
            assertThat(captor.getValue().getQuestions().get(1).getDragItems())
                    .extracting(DragItem::getCorrectOrder).containsExactly(2, 0, 1);
        }

        @Test
        @DisplayName("Association aux correctOrder tous à 0 ou absents → acceptée (correctOrder non utilisé)")
        void association_correctOrderNonVerifie() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(MATCHING)).thenReturn(Optional.of(type(5, MATCHING)));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));

            service.createQuiz(1, QuizDetailDTO.builder().title("T").questions(List.of(
                    QuestionDTO.builder().qType("matching").dragItems(List.of(
                            DragItemDTO.builder().content("a").correctOrder(0).groupName("G").build(),
                            DragItemDTO.builder().content("b").correctOrder(0).groupName("H").build(),
                            DragItemDTO.builder().content("c").groupName("G").build())).build()))
                    .build());

            verify(quizRepository).save(any(Quiz.class));
        }


        @Test
        @DisplayName("Cours introuvable → CourseNotFoundException, rien d'enregistré")
        void coursIntrouvable() {
            when(courseRepository.findById(1)).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.createQuiz(1, QuizDetailDTO.builder().title("T").build()))
                    .isInstanceOf(CourseNotFoundException.class);
            verifyNoInteractions(quizRepository, auditLogService, realtimePublisher);
        }

        @Test
        @DisplayName("Construit le quiz complet (valeurs par défaut), audite et diffuse quiz:created")
        void creeLeQuizComplet() {
            course.getQuizzes().add(quiz(5, course)); // position par défaut = nb de quiz existants
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(SINGLE)).thenReturn(Optional.of(type(2, SINGLE)));
            when(qTypeRepository.findById(6)).thenReturn(Optional.of(type(6, CODE)));
            when(languageRepository.findById(2)).thenReturn(Optional.of(language(2, "python")));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> {
                Quiz q = inv.getArgument(0);
                q.setId(77);
                return q;
            });

            QuizDetailDTO dto = QuizDetailDTO.builder()
                    .title("Récursivité")
                    .isPublished(true)
                    .questions(List.of(
                            QuestionDTO.builder().prompt("Choisir").qType("single_choice")
                                    .answers(List.of(
                                            AnswerDTO.builder().content("oui").isCorrect(true).build(),
                                            AnswerDTO.builder().content("non").build()))
                                    .dragItems(List.of(DragItemDTO.builder().content("d").groupName("G").build()))
                                    .build(),
                            QuestionDTO.builder().prompt("Coder").qTypeId(6).totalScore(4.0).orderIndex(7)
                                    .startCode("def f():")
                                    .language(LanguageDTO.builder().id(2).build())
                                    .testCases(List.of(TestCaseDTO.builder().name("t").harnessCode("h").build()))
                                    .build()))
                    .build();

            QuizDetailDTO created = service.createQuiz(1, dto);

            ArgumentCaptor<Quiz> captor = ArgumentCaptor.forClass(Quiz.class);
            verify(quizRepository).save(captor.capture());
            Quiz saved = captor.getValue();
            assertThat(saved.getCourse()).isSameAs(course);
            assertThat(saved.getTitle()).isEqualTo("Récursivité");
            assertThat(saved.getIsPublished()).isTrue();
            assertThat(saved.getIsDaily()).isFalse();
            assertThat(saved.getAllowRetry()).isFalse();
            assertThat(saved.getPosition()).isEqualTo(1);
            assertThat(saved.getCreatedAt()).isNotNull();

            Question choiceQ = saved.getQuestions().get(0);
            assertThat(choiceQ.getQuiz()).isSameAs(saved);
            assertThat(choiceQ.getPrompt()).isEqualTo("Choisir");
            assertThat(choiceQ.getAnswers()).extracting(Answer::getContent).containsExactly("oui", "non");
            assertThat(choiceQ.getOrderIndex()).isZero();
            assertThat(choiceQ.getTotalScore()).isZero();
            assertThat(choiceQ.getQType().getName()).isEqualTo(SINGLE);
            assertThat(choiceQ.getLanguage()).isNull();
            assertThat(choiceQ.getAnswers()).extracting(Answer::getIsCorrect).containsExactly(true, false);
            assertThat(choiceQ.getAnswers().get(0).getQuestion()).isSameAs(choiceQ);
            DragItem item = choiceQ.getDragItems().get(0);
            assertThat(item.getContent()).isEqualTo("d");
            assertThat(item.getCorrectOrder()).isZero();
            assertThat(item.getGroupName()).isEqualTo("G");
            assertThat(item.getQuestion()).isSameAs(choiceQ);

            Question codeQ = saved.getQuestions().get(1);
            assertThat(codeQ.getOrderIndex()).isEqualTo(7);
            assertThat(codeQ.getTotalScore()).isEqualTo(4.0);
            assertThat(codeQ.getStartCode()).isEqualTo("def f():");
            assertThat(codeQ.getLanguage().getName()).isEqualTo("python");
            TestCase tc = codeQ.getTestCases().get(0);
            assertThat(tc.getName()).isEqualTo("t");
            assertThat(tc.getWeight()).isEqualTo(1);
            assertThat(tc.getHarnessCode()).isEqualTo("h");
            assertThat(tc.getQuestion()).isSameAs(codeQ);

            // Réponse éditeur : correction incluse.
            assertThat(created.getId()).isEqualTo(77);
            assertThat(created.getQuestions().get(0).getAnswers().get(0).getIsCorrect()).isTrue();
            assertThat(created.getQuestions().get(1).getTestCases()).hasSize(1);

            verify(auditLogService).record("QUIZ_CREATE", "QUIZ", 77, "Quiz « Récursivité » créé", DETAILS);
            verify(realtimePublisher).quizCreated(11L, 1L, 77L);
            verify(realtimePublisher).quizCreated(12L, 1L, 77L);
            verify(realtimePublisher, never()).quizUpdated(anyLong(), anyLong(), anyLong());
        }

        @Test
        @DisplayName("Position explicite et quiz sans questions → conservés tels quels")
        void positionExplicite_sansQuestions() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));

            QuizDetailDTO created = service.createQuiz(1, QuizDetailDTO.builder()
                    .title("Vide").position(4).isDaily(true).allowRetry(true).build());

            assertThat(created.getPosition()).isEqualTo(4);
            assertThat(created.getIsDaily()).isTrue();
            assertThat(created.getAllowRetry()).isTrue();
            assertThat(created.getQuestions()).isEmpty();
            // Pas d'id persisté → aucune diffusion (broadcastQuiz ignore un id null).
            verifyNoInteractions(realtimePublisher);
        }

        @Test
        @DisplayName("orderIndex absent → position dans la liste (0, 1, 2…)")
        void orderIndexAbsent_positionDansLaListe() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(MATCHING)).thenReturn(Optional.of(type(5, MATCHING)));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));
            QuestionDTO sansIndex = QuestionDTO.builder().qType("matching").build();

            service.createQuiz(1, QuizDetailDTO.builder().title("T")
                    .questions(List.of(sansIndex, sansIndex, sansIndex)).build());

            ArgumentCaptor<Quiz> captor = ArgumentCaptor.forClass(Quiz.class);
            verify(quizRepository).save(captor.capture());
            assertThat(captor.getValue().getQuestions()).extracting(Question::getOrderIndex)
                    .containsExactly(0, 1, 2);
        }

        @Test
        @DisplayName("Listes absentes du DTO → collections vides MODIFIABLES (Hibernate, édition ultérieure)")
        void listesAbsentes_collectionsModifiables() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(MATCHING)).thenReturn(Optional.of(type(5, MATCHING)));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));

            // Quiz sans questions : la collection doit pouvoir recevoir des questions plus tard.
            service.createQuiz(1, QuizDetailDTO.builder().title("Vide").build());
            // Question sans réponses / éléments / harnais.
            service.createQuiz(1, QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().qType("matching").build())).build());

            ArgumentCaptor<Quiz> captor = ArgumentCaptor.forClass(Quiz.class);
            verify(quizRepository, org.mockito.Mockito.times(2)).save(captor.capture());
            Quiz empty = captor.getAllValues().get(0);
            empty.getQuestions().add(new Question());
            assertThat(empty.getQuestions()).hasSize(1);
            Question q = captor.getAllValues().get(1).getQuestions().get(0);
            q.getAnswers().add(new Answer());
            q.getDragItems().add(new DragItem());
            q.getTestCases().add(new TestCase());
            assertThat(q.getAnswers()).hasSize(1);
            assertThat(q.getDragItems()).hasSize(1);
            assertThat(q.getTestCases()).hasSize(1);
        }

        @Test
        @DisplayName("Slug de type inconnu → IllegalArgumentException, rien d'enregistré")
        void slugInconnu() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            QuizDetailDTO dto = QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().qType("essay").build())).build();

            assertThatThrownBy(() -> service.createQuiz(1, dto))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("essay");
            verify(quizRepository, never()).save(any());
        }

        @Test
        @DisplayName("Id de type inconnu → IllegalArgumentException")
        void idTypeInconnu() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findById(99)).thenReturn(Optional.empty());
            QuizDetailDTO dto = QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().qTypeId(99).build())).build();

            assertThatThrownBy(() -> service.createQuiz(1, dto))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("99");
        }

        @Test
        @DisplayName("Langage inconnu → IllegalArgumentException")
        void langageInconnu() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(qTypeRepository.findByName(CODE)).thenReturn(Optional.of(type(6, CODE)));
            when(languageRepository.findById(42)).thenReturn(Optional.empty());
            QuizDetailDTO dto = QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().qType("coding")
                            .language(LanguageDTO.builder().id(42).build()).build()))
                    .build();

            assertThatThrownBy(() -> service.createQuiz(1, dto))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Langage inconnu: 42");
        }

        @Test
        @DisplayName("Dans une transaction : quiz:created diffusé seulement APRÈS le commit")
        void diffusionApresCommit() {
            when(courseRepository.findById(1)).thenReturn(Optional.of(course));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> {
                Quiz q = inv.getArgument(0);
                q.setId(77);
                return q;
            });
            TransactionSynchronizationManager.initSynchronization();
            try {
                service.createQuiz(1, QuizDetailDTO.builder().title("T").build());

                verifyNoInteractions(realtimePublisher); // pas encore committé
                TransactionSynchronizationManager.getSynchronizations()
                        .forEach(TransactionSynchronization::afterCommit);
                verify(realtimePublisher).quizCreated(11L, 1L, 77L);
                verify(realtimePublisher).quizCreated(12L, 1L, 77L);
            } finally {
                TransactionSynchronizationManager.clearSynchronization();
            }
        }
    }

    // ── updateQuiz ──────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("updateQuiz : mise à jour en place (ids stables)")
    class Update {

        @Test
        @DisplayName("Mise à jour qui décoche la dernière bonne réponse → refusée, rien n'est enregistré")
        void decocheLaDerniereBonneReponse_refuse() {
            when(quizRepository.findById(5)).thenReturn(Optional.of(quiz));
            when(qTypeRepository.findByName(SINGLE)).thenReturn(Optional.of(type(2, SINGLE)));

            assertThatThrownBy(() -> service.updateQuiz(5, QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().id(1).qType("single_choice")
                            .answers(List.of(AnswerDTO.builder().id(10).content("A").isCorrect(false).build()))
                            .build()))
                    .build()))
                    .isInstanceOf(InvalidQuizException.class)
                    .hasMessageContaining("Question 1");
            verify(quizRepository, never()).save(any());
        }

        @Test
        @DisplayName("Mise à jour d'une remise en ordre avec un correctOrder absent → refusée (pas de repli à 0)")
        void remiseEnOrdre_correctOrderAbsent_refuse() {
            Question ordering = question(3, ORDERING, 1.0, 0);
            drag(ordering, 40, "a", 0, null);
            drag(ordering, 41, "b", 1, null);
            drag(ordering, 42, "c", 2, null);
            Quiz withOrdering = quiz(6, course, ordering);
            when(quizRepository.findById(6)).thenReturn(Optional.of(withOrdering));
            when(qTypeRepository.findByName(ORDERING)).thenReturn(Optional.of(type(4, ORDERING)));

            assertThatThrownBy(() -> service.updateQuiz(6, QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().id(3).qType("ordering").dragItems(List.of(
                            DragItemDTO.builder().id(40).content("a").build(),
                            DragItemDTO.builder().id(41).content("b").correctOrder(0).build(),
                            DragItemDTO.builder().id(42).content("c").correctOrder(1).build())).build()))
                    .build()))
                    .isInstanceOf(InvalidQuizException.class)
                    .hasMessage("Question 1 : chaque élément doit avoir une position distincte dans l'ordre attendu.");
            verify(quizRepository, never()).save(any());
        }

        @Test
        @DisplayName("Mise à jour qui ramène une remise en ordre à deux éléments → refusée, rien n'est enregistré")
        void remiseEnOrdre_rameneeADeuxElements_refuse() {
            Question ordering = question(3, ORDERING, 1.0, 0);
            drag(ordering, 40, "a", 0, null);
            drag(ordering, 41, "b", 1, null);
            drag(ordering, 42, "c", 2, null);
            when(quizRepository.findById(6)).thenReturn(Optional.of(quiz(6, course, ordering)));
            when(qTypeRepository.findByName(ORDERING)).thenReturn(Optional.of(type(4, ORDERING)));

            assertThatThrownBy(() -> service.updateQuiz(6, QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().id(3).qType("ordering").dragItems(List.of(
                            DragItemDTO.builder().id(40).content("a").correctOrder(0).build(),
                            DragItemDTO.builder().id(41).content("b").correctOrder(1).build())).build()))
                    .build()))
                    .isInstanceOf(InvalidQuizException.class)
                    .hasMessage("Question 1 : une remise en ordre doit avoir au moins 3 éléments.");
            verify(quizRepository, never()).save(any());
        }


        private Question kept;
        private Question removed;
        private Answer keptAnswer;
        private DragItem keptItem;
        private TestCase keptCase;
        private Quiz quiz;

        @BeforeEach
        void setUp() {
            kept = question(1, SINGLE, 1.0, 0);
            keptAnswer = answer(kept, 10, "ancienne", false);
            answer(kept, 11, "retirée", true);
            keptItem = drag(kept, 20, "item", 1, "A");
            drag(kept, 21, "item retiré", 2, "B");
            keptCase = testCase(kept, 30, "cas", 1);
            testCase(kept, 31, "cas retiré", 1);
            removed = question(2, SINGLE, 1.0, 1);
            kept.setStartCode("ancien code");
            kept.setLanguage(language(9, "java"));
            quiz = quiz(5, course, kept, removed);
            quiz.setTitle("Ancien titre");
        }

        @Test
        @DisplayName("Quiz introuvable → QuizNotFoundException")
        void introuvable() {
            when(quizRepository.findById(5)).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.updateQuiz(5, QuizDetailDTO.builder().build()))
                    .isInstanceOf(QuizNotFoundException.class);
        }

        @Test
        @DisplayName("Réutilise les entités gardées, retire les supprimées, ajoute les nouvelles")
        void reutiliseRetireEtAjoute() {
            when(quizRepository.findById(5)).thenReturn(Optional.of(quiz));
            when(qTypeRepository.findByName(SINGLE)).thenReturn(Optional.of(type(2, SINGLE)));
            when(qTypeRepository.findByName(MATCHING)).thenReturn(Optional.of(type(5, MATCHING)));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));

            QuizDetailDTO dto = QuizDetailDTO.builder()
                    .title("Nouveau titre").allowRetry(true).position(3)
                    .questions(List.of(
                            QuestionDTO.builder().id(1).prompt("modifiée").qType("single_choice").totalScore(2.0)
                                    .startCode("nouveau code")
                                    .answers(List.of(
                                            AnswerDTO.builder().id(10).content("mise à jour").isCorrect(true).build(),
                                            AnswerDTO.builder().content("ajoutée").build()))
                                    .dragItems(List.of(
                                            DragItemDTO.builder().id(20).content("item modifié").groupName("C").build(),
                                            DragItemDTO.builder().content("nouvel item").correctOrder(4).build()))
                                    .testCases(List.of(
                                            TestCaseDTO.builder().id(30).name("cas modifié").harnessCode("h2").weight(5).build(),
                                            TestCaseDTO.builder().name("nouveau cas").harnessCode("h3").build()))
                                    .build(),
                            // id inconnu → traité comme une nouvelle question
                            QuestionDTO.builder().id(999).prompt("nouvelle").qType("matching").build()))
                    .build();

            QuizDetailDTO result = service.updateQuiz(5, dto);

            assertThat(quiz.getTitle()).isEqualTo("Nouveau titre");
            assertThat(quiz.getAllowRetry()).isTrue();
            assertThat(quiz.getPosition()).isEqualTo(3);
            assertThat(quiz.getQuestions()).hasSize(2);
            assertThat(quiz.getQuestions().get(0)).isSameAs(kept);
            Question added = quiz.getQuestions().get(1);
            assertThat(added).isNotSameAs(removed);
            assertThat(added.getId()).isNull();
            assertThat(added.getPrompt()).isEqualTo("nouvelle");
            assertThat(added.getOrderIndex()).isEqualTo(1);
            assertThat(added.getQuiz()).isSameAs(quiz);

            assertThat(kept.getPrompt()).isEqualTo("modifiée");
            assertThat(kept.getTotalScore()).isEqualTo(2.0);
            assertThat(kept.getStartCode()).isEqualTo("nouveau code");
            // Type re-résolu depuis le DTO (id 2 du dépôt, pas l'ancien) ; langage retiré du DTO → null.
            assertThat(kept.getQType().getId()).isEqualTo(2);
            assertThat(kept.getLanguage()).isNull();
            assertThat(kept.getAnswers()).hasSize(2);
            assertThat(kept.getAnswers().get(0)).isSameAs(keptAnswer);
            assertThat(keptAnswer.getContent()).isEqualTo("mise à jour");
            assertThat(keptAnswer.getIsCorrect()).isTrue();
            assertThat(kept.getAnswers().get(1).getContent()).isEqualTo("ajoutée");
            assertThat(kept.getAnswers().get(1).getIsCorrect()).isFalse();
            assertThat(kept.getAnswers().get(1).getQuestion()).isSameAs(kept);

            assertThat(kept.getDragItems()).hasSize(2);
            assertThat(kept.getDragItems().get(0)).isSameAs(keptItem);
            assertThat(keptItem.getContent()).isEqualTo("item modifié");
            assertThat(keptItem.getCorrectOrder()).isZero();
            assertThat(keptItem.getGroupName()).isEqualTo("C");
            assertThat(kept.getDragItems().get(1).getCorrectOrder()).isEqualTo(4);
            assertThat(kept.getDragItems().get(1).getContent()).isEqualTo("nouvel item");
            assertThat(kept.getDragItems().get(1).getQuestion()).isSameAs(kept);

            assertThat(kept.getTestCases()).hasSize(2);
            assertThat(kept.getTestCases().get(0)).isSameAs(keptCase);
            assertThat(keptCase.getName()).isEqualTo("cas modifié");
            assertThat(keptCase.getWeight()).isEqualTo(5);
            assertThat(keptCase.getHarnessCode()).isEqualTo("h2");
            assertThat(kept.getTestCases().get(1).getHarnessCode()).isEqualTo("h3");
            assertThat(kept.getTestCases().get(1).getWeight()).isEqualTo(1);
            assertThat(kept.getTestCases().get(1).getQuestion()).isSameAs(kept);

            assertThat(result.getTitle()).isEqualTo("Nouveau titre");
            verify(auditLogService).record("QUIZ_UPDATE", "QUIZ", 5, "Quiz « Nouveau titre » mis à jour", DETAILS);
            verify(realtimePublisher).quizUpdated(11L, 1L, 5L);
            verify(realtimePublisher).quizUpdated(12L, 1L, 5L);
            verify(realtimePublisher, never()).quizCreated(anyLong(), anyLong(), anyLong());
        }

        @Test
        @DisplayName("Collections nulles (quiz et question réutilisée) → initialisées puis remplies")
        void collectionsNulles_initialisees() {
            kept.setAnswers(null);
            kept.setDragItems(null);
            kept.setTestCases(null);
            quiz.setQuestions(null);
            when(quizRepository.findById(5)).thenReturn(Optional.of(quiz));
            when(qTypeRepository.findByName(MATCHING)).thenReturn(Optional.of(type(5, MATCHING)));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));

            service.updateQuiz(5, QuizDetailDTO.builder().title("T")
                    .questions(List.of(QuestionDTO.builder().prompt("p").qType("matching").build()))
                    .build());

            assertThat(quiz.getQuestions()).singleElement().satisfies(q -> {
                assertThat(q.getAnswers()).isEmpty();
                assertThat(q.getDragItems()).isEmpty();
                assertThat(q.getTestCases()).isEmpty();
            });
        }

        @Test
        @DisplayName("Aucune question dans le DTO → toutes les questions sont retirées")
        void sansQuestions_toutRetire() {
            when(quizRepository.findById(5)).thenReturn(Optional.of(quiz));
            when(quizRepository.save(any(Quiz.class))).thenAnswer(inv -> inv.getArgument(0));

            QuizDetailDTO result = service.updateQuiz(5, QuizDetailDTO.builder().title("T").build());

            assertThat(quiz.getQuestions()).isEmpty();
            assertThat(result.getQuestions()).isEmpty();
        }
    }

    // ── deleteQuiz ──────────────────────────────────────────────────────────────

    @Test
    @DisplayName("Suppression : delete, audit avec le titre capturé, quiz:deleted à chaque programme")
    void deleteQuiz_supprimeAuditeEtDiffuse() {
        Quiz quiz = quiz(5, course);
        when(quizRepository.findById(5)).thenReturn(Optional.of(quiz));

        service.deleteQuiz(5);

        verify(quizRepository).delete(quiz);
        verify(auditLogService).record("QUIZ_DELETE", "QUIZ", 5, "Quiz « Quiz 5 » supprimé", DETAILS);
        verify(realtimePublisher).quizDeleted(11L, 1L, 5L);
        verify(realtimePublisher).quizDeleted(12L, 1L, 5L);
    }

    @Test
    @DisplayName("Suppression d'un quiz sans titre ni cours → résumé générique, aucune diffusion")
    void deleteQuiz_sansTitreNiCours() {
        Quiz quiz = quiz(5, null);
        quiz.setTitle(null);
        when(quizRepository.findById(5)).thenReturn(Optional.of(quiz));

        service.deleteQuiz(5);

        verify(auditLogService).record(eq("QUIZ_DELETE"), eq("QUIZ"), eq(5), eq("Quiz #5 supprimé"), isNull());
        verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("Suppression d'un quiz introuvable → QuizNotFoundException, rien supprimé")
    void deleteQuiz_introuvable() {
        when(quizRepository.findById(5)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.deleteQuiz(5)).isInstanceOf(QuizNotFoundException.class);
        verify(quizRepository, never()).delete(any());
    }

    // ── reorderQuizzes ──────────────────────────────────────────────────────────

    @Test
    @DisplayName("Réordonnancement : positions 0..n dans l'ordre donné, ids inconnus ignorés")
    void reorderQuizzes_positionsEtDiffusion() {
        Quiz a = quiz(1, course);
        Quiz b = quiz(2, course);
        Quiz c = quiz(3, course);
        course.getQuizzes().addAll(List.of(a, b, c));
        when(courseRepository.findById(1)).thenReturn(Optional.of(course));

        service.reorderQuizzes(1, List.of(3, 99, 1, 2));

        assertThat(c.getPosition()).isZero();
        assertThat(a.getPosition()).isEqualTo(1);
        assertThat(b.getPosition()).isEqualTo(2);
        verify(quizRepository).save(a);
        verify(quizRepository).save(b);
        verify(quizRepository).save(c);
        verify(realtimePublisher).quizReordered(11L, 1L);
        verify(realtimePublisher).quizReordered(12L, 1L);
    }

    @Test
    @DisplayName("Réordonnancement d'un cours sans quiz ni programme → aucune sauvegarde ni diffusion")
    void reorderQuizzes_coursVide() {
        course.setQuizzes(null);
        course.setPrograms(null);
        when(courseRepository.findById(1)).thenReturn(Optional.of(course));

        service.reorderQuizzes(1, List.of(1, 2));

        verify(quizRepository, never()).save(any());
        verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("Réordonnancement d'un cours introuvable → CourseNotFoundException")
    void reorderQuizzes_coursIntrouvable() {
        when(courseRepository.findById(1)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.reorderQuizzes(1, List.of(1)))
                .isInstanceOf(CourseNotFoundException.class);
        verify(quizRepository, never()).save(any());
        verify(realtimePublisher, never()).quizReordered(anyLong(), anyLong());
        verify(courseRepository, never()).save(any());
        verify(quizRepository, never()).findById(anyInt());
    }
}
