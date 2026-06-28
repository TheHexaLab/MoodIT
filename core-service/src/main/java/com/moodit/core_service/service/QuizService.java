package com.moodit.core_service.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.AlreadySubmittedException;
import com.moodit.core_service.exception.AttemptNotFoundException;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.*;
import com.moodit.core_service.repository.AttemptRepository;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.QTypeRepository;
import com.moodit.core_service.repository.QuizRepository;
import com.moodit.core_service.repository.SubmissionRepository;
import com.moodit.core_service.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class QuizService {

    private final QuizRepository quizRepository;
    private final CourseRepository courseRepository;
    private final QTypeRepository qTypeRepository;
    private final SubmissionRepository submissionRepository;
    private final AttemptRepository attemptRepository;
    private final UserRepository userRepository;
    private final ObjectMapper objectMapper;

    /**
     * Correspondance Q_Type.name (libellé FR en base) ↔ slug front (discriminant stable).
     * Doit rester synchronisée avec QUESTION_TYPE_LABELS côté front.
     */
    private static final Map<String, String> Q_TYPE_NAME_TO_SLUG = Map.of(
            "Vrai/Faux", "true_false",
            "Choix unique", "single_choice",
            "Choix multiple", "multiple_choice",
            "Remise en ordre", "ordering",
            "Association", "matching",
            "Code", "coding"
    );
    private static final Map<String, String> Q_TYPE_SLUG_TO_NAME = Q_TYPE_NAME_TO_SLUG.entrySet().stream()
            .collect(Collectors.toMap(Map.Entry::getValue, Map.Entry::getKey));

    // ── Lecture ────────────────────────────────────────────────────────────────

    /** Types de question disponibles (table Q_Type), triés par id. */
    @Transactional(readOnly = true)
    public List<QuestionTypeDTO> getQuestionTypes() {
        return qTypeRepository.findAll().stream()
                .sorted(Comparator.comparing(QType::getId))
                .map(t -> new QuestionTypeDTO(t.getId(), Q_TYPE_NAME_TO_SLUG.get(t.getName()), t.getName()))
                .toList();
    }

    /** Quiz d'un cours (méta seule), triés par position. `publishedOnly` filtre les publiés. */
    @Transactional(readOnly = true)
    public List<QuizDTO> listQuizzes(Integer courseId, boolean publishedOnly) {
        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);
        return (course.getQuizzes() == null ? List.<Quiz>of() : course.getQuizzes()).stream()
                .filter(q -> !publishedOnly || Boolean.TRUE.equals(q.getIsPublished()))
                .sorted(Comparator.comparing(Quiz::getPosition,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .map(this::toQuizMetaDTO)
                .toList();
    }

    /** Détail complet d'un quiz (méta + questions embarquées). Sans les harnais (Test_Case). */
    @Transactional(readOnly = true)
    public QuizDetailDTO getQuizDetail(Integer quizId) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        return toQuizDetailDTO(quiz);
    }

    // ── Écriture (éditeur enseignant) ────────────────────────────────────────────

    /** Crée un quiz complet (méta + questions) dans un cours ; renvoie le quiz persisté. */
    @Transactional
    public QuizDetailDTO createQuiz(Integer courseId, QuizDetailDTO dto) {
        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);

        Quiz quiz = new Quiz();
        quiz.setCourse(course);
        quiz.setCreatedAt(LocalDateTime.now());
        applyQuizMeta(quiz, dto, course);
        quiz.setQuestions(buildQuestions(dto.getQuestions(), quiz));

        return toQuizDetailDTO(quizRepository.save(quiz));
    }

    /** Met à jour un quiz complet en un appel (remplace ses questions). */
    @Transactional
    public QuizDetailDTO updateQuiz(Integer quizId, QuizDetailDTO dto) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);

        applyQuizMeta(quiz, dto, quiz.getCourse());

        // Remplacement intégral des questions : orphanRemoval supprime les anciennes.
        if (quiz.getQuestions() == null) {
            quiz.setQuestions(new ArrayList<>());
        }
        quiz.getQuestions().clear();
        quiz.getQuestions().addAll(buildQuestions(dto.getQuestions(), quiz));

        return toQuizDetailDTO(quizRepository.save(quiz));
    }

    /** Supprime un quiz et tout son contenu (cascade). */
    @Transactional
    public void deleteQuiz(Integer quizId) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        quizRepository.delete(quiz);
    }

    /** Réordonne les quiz d'un cours : `quizIds` dans le nouvel ordre → position 0..n. */
    @Transactional
    public void reorderQuizzes(Integer courseId, List<Integer> quizIds) {
        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);
        Map<Integer, Quiz> byId = (course.getQuizzes() == null ? List.<Quiz>of() : course.getQuizzes())
                .stream().collect(Collectors.toMap(Quiz::getId, q -> q));
        int position = 0;
        for (Integer id : quizIds) {
            Quiz quiz = byId.get(id);
            if (quiz != null) {
                quiz.setPosition(position++);
                quizRepository.save(quiz);
            }
        }
    }

    // ── Soumission / correction ──────────────────────────────────────────────────

    /**
     * Corrige une tentative côté serveur (types « à réponses ») et PERSISTE les
     * soumissions (une par question). Tentative unique : 409 si déjà soumis. Le CODE
     * n'est pas exécuté ici (tests = null). `userEmail` vient du JWT (header gateway).
     */
    @Transactional
    public QuizResultDTO submitQuiz(Integer quizId, QuizSubmissionDTO submission, String userEmail) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);

        long existing = attemptRepository.countByQuiz_IdAndUser_Id(quizId, user.getId());
        // Tentative unique si le quiz n'autorise pas la reprise.
        if (existing > 0 && !Boolean.TRUE.equals(quiz.getAllowRetry())) {
            throw new AlreadySubmittedException();
        }

        Map<Integer, SubmittedAnswerDTO> byQuestion = toAnswerMap(submission.getAnswers());
        QuizResultDTO result = buildResult(quiz, byQuestion);

        // Nouvelle tentative (numéro = nb existant + 1).
        Attempt attempt = new Attempt();
        attempt.setQuiz(quiz);
        attempt.setUser(user);
        attempt.setAttemptNo((int) existing + 1);
        attempt.setScore(result.getEarned());
        attempt.setMaxScore(result.getMax());
        Attempt savedAttempt = attemptRepository.save(attempt);

        // Une Submission par question, rattachée à la tentative (réponse brute + score).
        Map<Integer, Integer> earnedByQuestion = result.getQuestions().stream()
                .collect(Collectors.toMap(QuestionResultDTO::getQuestionId, QuestionResultDTO::getEarned));
        for (Question q : sortedQuestions(quiz)) {
            Submission s = new Submission();
            s.setAttempt(savedAttempt);
            s.setUser(user);
            s.setQuestion(q);
            s.setScore(earnedByQuestion.get(q.getId()));
            s.setContent(serializeAnswer(byQuestion.get(q.getId())));
            submissionRepository.save(s);
        }

        result.setAttemptId(savedAttempt.getId());
        result.setAttemptNo(savedAttempt.getAttemptNo());
        return result;
    }

    /** Historique des tentatives de l'utilisateur sur un quiz (résumés, ordre croissant). */
    @Transactional(readOnly = true)
    public List<AttemptSummaryDTO> getMyAttempts(Integer quizId, String userEmail) {
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);
        return attemptRepository.findByQuiz_IdAndUser_IdOrderByAttemptNoAsc(quizId, user.getId()).stream()
                .map(a -> new AttemptSummaryDTO(
                        a.getId(),
                        a.getAttemptNo(),
                        a.getScore(),
                        a.getMaxScore(),
                        a.getSubmittedAt() == null ? null : a.getSubmittedAt().toInstant(ZoneOffset.UTC)))
                .toList();
    }

    /** Résultat corrigé d'UNE tentative donnée (révision), restreint à son propriétaire. */
    @Transactional(readOnly = true)
    public QuizResultDTO getAttemptResult(Integer attemptId, String userEmail) {
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);
        Attempt attempt = attemptRepository.findByIdAndUser_Id(attemptId, user.getId())
                .orElseThrow(AttemptNotFoundException::new);

        Map<Integer, SubmittedAnswerDTO> byQuestion =
                (attempt.getSubmissions() == null ? List.<Submission>of() : attempt.getSubmissions()).stream()
                        .collect(Collectors.toMap(
                                s -> s.getQuestion().getId(),
                                s -> deserializeAnswer(s.getContent(), s.getQuestion().getId()),
                                (a, b) -> a));

        QuizResultDTO result = buildResult(attempt.getQuiz(), byQuestion);
        result.setAttemptId(attempt.getId());
        result.setAttemptNo(attempt.getAttemptNo());
        return result;
    }

    private Map<Integer, SubmittedAnswerDTO> toAnswerMap(List<SubmittedAnswerDTO> answers) {
        return (answers == null ? List.<SubmittedAnswerDTO>of() : answers).stream()
                .collect(Collectors.toMap(SubmittedAnswerDTO::getQuestionId, a -> a, (a, b) -> a));
    }

    /** Corrige toutes les questions du quiz à partir des réponses fournies (sans persister). */
    private QuizResultDTO buildResult(Quiz quiz, Map<Integer, SubmittedAnswerDTO> byQuestion) {
        List<QuestionResultDTO> results = sortedQuestions(quiz).stream()
                .map(q -> gradeQuestion(q, byQuestion.get(q.getId())))
                .toList();
        return QuizResultDTO.builder()
                .quizId(quiz.getId())
                .earned(results.stream().mapToInt(QuestionResultDTO::getEarned).sum())
                .max(results.stream().mapToInt(QuestionResultDTO::getMax).sum())
                .questions(results)
                .build();
    }

    private List<Question> sortedQuestions(Quiz quiz) {
        return (quiz.getQuestions() == null ? List.<Question>of() : quiz.getQuestions())
                .stream()
                .sorted(Comparator.comparing(Question::getOrderIndex,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .toList();
    }

    /** Sérialise la réponse brute soumise pour la stocker (Submission.content). */
    private String serializeAnswer(SubmittedAnswerDTO answer) {
        if (answer == null) return null;
        try {
            return objectMapper.writeValueAsString(answer);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    /** Reconstruit la réponse soumise depuis Submission.content (réhydratation). */
    private SubmittedAnswerDTO deserializeAnswer(String content, Integer questionId) {
        if (content != null && !content.isBlank()) {
            try {
                SubmittedAnswerDTO answer = objectMapper.readValue(content, SubmittedAnswerDTO.class);
                if (answer.getQuestionId() == null) answer.setQuestionId(questionId);
                return answer;
            } catch (JsonProcessingException ignored) {
                // contenu illisible → réponse vide ci-dessous
            }
        }
        SubmittedAnswerDTO empty = new SubmittedAnswerDTO();
        empty.setQuestionId(questionId);
        return empty;
    }

    // ── Grading (porté de grading.ts côté front) ─────────────────────────────────

    private QuestionResultDTO gradeQuestion(Question question, SubmittedAnswerDTO answer) {
        String slug = slugFor(question);
        if (slug == null) slug = "";
        return switch (slug) {
            case "true_false", "single_choice", "multiple_choice" -> gradeChoice(question, answer, slug);
            case "ordering" -> gradeOrdering(question, answer);
            case "matching" -> gradeMatching(question, answer);
            default -> // coding : non corrigé côté serveur
                    QuestionResultDTO.builder()
                            .questionId(question.getId())
                            .earned(0)
                            .max(question.getTotalScore())
                            .tests(null)
                            .build();
        };
    }

    private QuestionResultDTO gradeChoice(Question question, SubmittedAnswerDTO answer, String slug) {
        List<Answer> options = question.getAnswers() == null ? List.of() : question.getAnswers();
        List<Integer> correctIds = options.stream()
                .filter(o -> Boolean.TRUE.equals(o.getIsCorrect()))
                .map(Answer::getId).toList();
        List<Integer> selectedIds = answer != null && answer.getAnswerIds() != null
                ? answer.getAnswerIds() : List.of();
        Set<Integer> correctSet = new HashSet<>(correctIds);

        int total = question.getTotalScore();
        int earned;
        if ("multiple_choice".equals(slug)) {
            long good = selectedIds.stream().filter(correctSet::contains).count();
            long bad = selectedIds.stream().filter(id -> !correctSet.contains(id)).count();
            double ratio = correctIds.isEmpty() ? 0 : (double) (good - bad) / correctIds.size();
            earned = scaled(total, ratio);
        } else {
            Set<Integer> selectedSet = new HashSet<>(selectedIds);
            boolean exact = selectedSet.equals(correctSet);
            earned = exact ? total : 0;
        }

        return QuestionResultDTO.builder()
                .questionId(question.getId())
                .earned(earned)
                .max(total)
                .correctAnswerIds(correctIds)
                .selectedAnswerIds(selectedIds)
                .build();
    }

    private QuestionResultDTO gradeOrdering(Question question, SubmittedAnswerDTO answer) {
        List<DragItem> items = question.getDragItems() == null ? List.of() : question.getDragItems();
        List<Integer> correctOrder = items.stream()
                .sorted(Comparator.comparing(d -> d.getCorrectOrder() == null ? 0 : d.getCorrectOrder()))
                .map(DragItem::getId).toList();
        List<Integer> submittedOrder = answer != null && answer.getOrderedItemIds() != null
                ? answer.getOrderedItemIds() : List.of();

        int correctCount = 0;
        for (int i = 0; i < submittedOrder.size() && i < correctOrder.size(); i++) {
            if (correctOrder.get(i).equals(submittedOrder.get(i))) correctCount++;
        }
        double ratio = items.isEmpty() ? 0 : (double) correctCount / items.size();

        return QuestionResultDTO.builder()
                .questionId(question.getId())
                .earned(scaled(question.getTotalScore(), ratio))
                .max(question.getTotalScore())
                .correctOrder(correctOrder)
                .submittedOrder(submittedOrder)
                .build();
    }

    private QuestionResultDTO gradeMatching(Question question, SubmittedAnswerDTO answer) {
        List<DragItem> items = question.getDragItems() == null ? List.of() : question.getDragItems();
        Map<Integer, String> placement = answer != null && answer.getPlacement() != null
                ? answer.getPlacement() : Map.of();

        List<MatchingItemResultDTO> matching = items.stream().map(d -> {
            String chosen = placement.get(d.getId());
            String correctGroup = d.getGroupName() == null ? "" : d.getGroupName();
            boolean correct = correctGroup.equals(chosen);
            return new MatchingItemResultDTO(d.getId(), chosen, correctGroup, correct);
        }).toList();

        long correctCount = matching.stream().filter(MatchingItemResultDTO::getCorrect).count();
        double ratio = items.isEmpty() ? 0 : (double) correctCount / items.size();

        return QuestionResultDTO.builder()
                .questionId(question.getId())
                .earned(scaled(question.getTotalScore(), ratio))
                .max(question.getTotalScore())
                .matching(matching)
                .build();
    }

    /** Score proportionnel borné, arrondi : total × clamp(ratio, 0, 1). */
    private int scaled(int total, double ratio) {
        return (int) Math.round(total * Math.max(0, Math.min(1, ratio)));
    }

    // ── Construction d'entités (écriture) ────────────────────────────────────────

    private void applyQuizMeta(Quiz quiz, QuizDetailDTO dto, Course course) {
        quiz.setTitle(dto.getTitle());
        quiz.setIsDaily(Boolean.TRUE.equals(dto.getIsDaily()));
        quiz.setIsPublished(Boolean.TRUE.equals(dto.getIsPublished()));
        quiz.setAllowRetry(Boolean.TRUE.equals(dto.getAllowRetry()));
        int fallback = course != null && course.getQuizzes() != null ? course.getQuizzes().size() : 0;
        quiz.setPosition(dto.getPosition() != null ? dto.getPosition() : fallback);
    }

    private List<Question> buildQuestions(List<QuestionDTO> dtos, Quiz quiz) {
        List<Question> questions = new ArrayList<>();
        if (dtos == null) return questions;
        int index = 0;
        for (QuestionDTO qd : dtos) {
            Question q = new Question();
            q.setQuiz(quiz);
            q.setPrompt(qd.getPrompt());
            q.setStartCode(qd.getStartCode());
            q.setOrderIndex(qd.getOrderIndex() != null ? qd.getOrderIndex() : index);
            q.setTotalScore(qd.getTotalScore() != null ? qd.getTotalScore() : 0);
            q.setQType(resolveQType(qd));
            q.setAnswers(buildAnswers(qd.getAnswers(), q));
            q.setDragItems(buildDragItems(qd.getDragItems(), q));
            questions.add(q);
            index++;
        }
        return questions;
    }

    private QType resolveQType(QuestionDTO qd) {
        if (qd.getQTypeId() != null) {
            return qTypeRepository.findById(qd.getQTypeId())
                    .orElseThrow(() -> new IllegalArgumentException("Type de question inconnu: " + qd.getQTypeId()));
        }
        String name = Q_TYPE_SLUG_TO_NAME.get(qd.getQType());
        return Optional.ofNullable(name).flatMap(qTypeRepository::findByName)
                .orElseThrow(() -> new IllegalArgumentException("Type de question inconnu: " + qd.getQType()));
    }

    private List<Answer> buildAnswers(List<AnswerDTO> dtos, Question question) {
        List<Answer> answers = new ArrayList<>();
        if (dtos == null) return answers;
        for (AnswerDTO ad : dtos) {
            Answer a = new Answer();
            a.setContent(ad.getContent());
            a.setIsCorrect(Boolean.TRUE.equals(ad.getIsCorrect()));
            a.setQuestion(question);
            answers.add(a);
        }
        return answers;
    }

    private List<DragItem> buildDragItems(List<DragItemDTO> dtos, Question question) {
        List<DragItem> items = new ArrayList<>();
        if (dtos == null) return items;
        for (DragItemDTO dd : dtos) {
            DragItem d = new DragItem();
            d.setContent(dd.getContent());
            d.setCorrectOrder(dd.getCorrectOrder() != null ? dd.getCorrectOrder() : 0);
            d.setGroupName(dd.getGroupName());
            d.setQuestion(question);
            items.add(d);
        }
        return items;
    }

    // ── Mapping entité → DTO ─────────────────────────────────────────────────────

    private QuizDTO toQuizMetaDTO(Quiz quiz) {
        return QuizDTO.builder()
                .id(quiz.getId())
                .title(quiz.getTitle())
                .position(quiz.getPosition())
                .isPublished(quiz.getIsPublished())
                .isDaily(quiz.getIsDaily())
                .allowRetry(quiz.getAllowRetry())
                .questionCount(quiz.getQuestions() == null ? 0 : quiz.getQuestions().size())
                .createdAt(quiz.getCreatedAt())
                .build();
    }

    private QuizDetailDTO toQuizDetailDTO(Quiz quiz) {
        return QuizDetailDTO.builder()
                .id(quiz.getId())
                .title(quiz.getTitle())
                .position(quiz.getPosition())
                .isPublished(quiz.getIsPublished())
                .isDaily(quiz.getIsDaily())
                .allowRetry(quiz.getAllowRetry())
                .questions(quiz.getQuestions() == null ? List.of()
                        : quiz.getQuestions().stream()
                        .sorted(Comparator.comparing(Question::getOrderIndex,
                                Comparator.nullsLast(Comparator.naturalOrder())))
                        .map(this::toQuestionDTO)
                        .toList())
                .build();
    }

    private QuestionDTO toQuestionDTO(Question question) {
        return QuestionDTO.builder()
                .id(question.getId())
                .prompt(question.getPrompt())
                .qType(slugFor(question))
                .qTypeId(question.getQType() != null ? question.getQType().getId() : null)
                .totalScore(question.getTotalScore())
                .orderIndex(question.getOrderIndex())
                .startCode(question.getStartCode())
                .answers(question.getAnswers() == null ? List.of()
                        : question.getAnswers().stream().map(this::toAnswerDTO).toList())
                .dragItems(question.getDragItems() == null ? List.of()
                        : question.getDragItems().stream().map(this::toDragItemDTO).toList())
                .build();
    }

    private String slugFor(Question question) {
        if (question.getQType() == null) return null;
        return Q_TYPE_NAME_TO_SLUG.get(question.getQType().getName());
    }

    private AnswerDTO toAnswerDTO(Answer answer) {
        return AnswerDTO.builder()
                .id(answer.getId())
                .content(answer.getContent())
                .isCorrect(answer.getIsCorrect())
                .build();
    }

    private DragItemDTO toDragItemDTO(DragItem dragItem) {
        return DragItemDTO.builder()
                .id(dragItem.getId())
                .content(dragItem.getContent())
                .correctOrder(dragItem.getCorrectOrder())
                .groupName(dragItem.getGroupName())
                .build();
    }
}
