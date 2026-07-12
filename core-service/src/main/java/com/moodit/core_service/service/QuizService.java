package com.moodit.core_service.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.AlreadySubmittedException;
import com.moodit.core_service.exception.AttemptNotFoundException;
import com.moodit.core_service.exception.CodeVerificationUnavailableException;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.*;
import com.moodit.core_service.repository.AttemptRepository;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.LanguageRepository;
import com.moodit.core_service.repository.QTypeRepository;
import com.moodit.core_service.repository.QuizRepository;
import com.moodit.core_service.repository.SubmissionRepository;
import com.moodit.core_service.repository.SubmissionTestCaseRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class QuizService {

    private final QuizRepository quizRepository;
    private final CourseRepository courseRepository;
    private final QTypeRepository qTypeRepository;
    private final LanguageRepository languageRepository;
    private final SubmissionRepository submissionRepository;
    private final SubmissionTestCaseRepository submissionTestCaseRepository;
    private final AttemptRepository attemptRepository;
    private final UserRepository userRepository;
    private final ObjectMapper objectMapper;
    private final RealtimeEventPublisher realtimePublisher;
    private final ExecutionClient executionClient;
    private final PlatformTransactionManager transactionManager;
    private final ApplicationEventPublisher eventPublisher;
    private final AuditLogService auditLogService;

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

    /** Langages d'exécution (table Language), COMPLETS (templates inclus) pour l'éditeur, triés par id. */
    @Transactional(readOnly = true)
    public List<LanguageDTO> getLanguages() {
        return languageRepository.findAll().stream()
                .sorted(Comparator.comparing(Language::getId))
                .map(l -> LanguageDTO.builder()
                        .id(l.getId())
                        .name(l.getName())
                        .harnessTemplate(l.getHarnessTemplate())
                        .startCodeTemplate(l.getStartCodeTemplate())
                        .harnessLanguageId(l.getHarnessLanguageId())
                        .build())
                .toList();
    }

    /**
     * Quiz d'un cours (méta seule), triés par position. `publishedOnly` filtre les publiés.
     * L'autorisation de la vue ÉDITEUR (brouillons compris, publishedOnly=false) est déléguée au
     * permission-service via une ROUTE DÉDIÉE (GET /courses/{id}/quizzes/manage) — la vue publiée
     * (publishedOnly=true) est ouverte à tout membre. Ce service ne fait donc plus de contrôle.
     */
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

    /**
     * Détail d'un quiz pour la PASSATION (étudiant). Les champs de correction
     * (isCorrect, correctOrder, groupName) et les harnais (Test_Case) sont EXCLUS :
     * le client n'en a pas besoin (la correction se fait côté serveur) et les exposer
     * permettrait de tricher.
     */
    @Transactional(readOnly = true)
    public QuizDetailDTO getQuizDetail(Integer quizId) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        return toQuizDetailDTO(quiz, false);
    }

    /**
     * Détail complet d'un quiz pour l'ÉDITEUR enseignant : inclut la correction
     * (isCorrect, correctOrder, groupName). Réservé à ceux qui gèrent le contenu du cours
     * (cf. {@link #requireCourseAccess}) — un étudiant qui appellerait cet endpoint reçoit 403.
     */
    @Transactional(readOnly = true)
    public QuizDetailDTO getQuizForEdit(Integer quizId) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        // Autorisation PAR RÔLE déléguée au permission-service (règle GET /quizzes/{quizId}/edit).
        return toQuizDetailDTO(quiz, true);
    }

    // ── Écriture (éditeur enseignant) ────────────────────────────────────────────

    /** Crée un quiz complet (méta + questions) dans un cours ; renvoie le quiz persisté. */
    @Transactional
    public QuizDetailDTO createQuiz(Integer courseId, QuizDetailDTO dto) {
        // Autorisation PAR RÔLE déléguée au permission-service (règle POST /courses/{id}/quizzes).
        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);

        Quiz quiz = new Quiz();
        quiz.setCourse(course);
        quiz.setCreatedAt(LocalDateTime.now());
        applyQuizMeta(quiz, dto, course);
        quiz.setQuestions(buildQuestions(dto.getQuestions(), quiz));

        Quiz saved = quizRepository.save(quiz);
        String details = AuditContext.ofChildOfCourse(course);
        auditLogService.record("QUIZ_CREATE", "QUIZ", saved.getId(),
                "Quiz « " + saved.getTitle() + " » créé", details);
        broadcastQuiz(course, saved.getId(), false); // created
        return toQuizDetailDTO(saved, true); // éditeur → renvoie la correction
    }

    /**
     * Met à jour un quiz complet en un appel. Les questions EXISTANTES sont réutilisées
     * (même id) afin de PRÉSERVER les soumissions liées (Submission.question_id) : éditer
     * le quiz (ex. (dés)activer les reprises) ne détruit pas l'historique des tentatives.
     * Seules les questions réellement retirées sont supprimées (orphanRemoval).
     */
    @Transactional
    public QuizDetailDTO updateQuiz(Integer quizId, QuizDetailDTO dto) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        // Autorisation PAR RÔLE déléguée au permission-service (règle PUT /quizzes/{quizId}).

        applyQuizMeta(quiz, dto, quiz.getCourse());

        if (quiz.getQuestions() == null) {
            quiz.setQuestions(new ArrayList<>());
        }
        List<Question> current = quiz.getQuestions();
        Map<Integer, Question> existingById = current.stream()
                .filter(q -> q.getId() != null)
                .collect(Collectors.toMap(Question::getId, q -> q));

        List<QuestionDTO> dtos = dto.getQuestions() == null ? List.of() : dto.getQuestions();
        Set<Integer> keptIds = dtos.stream()
                .map(QuestionDTO::getId)
                .filter(id -> id != null && existingById.containsKey(id))
                .collect(Collectors.toSet());

        // On NE vide PAS la collection (un clear() ré-orphanerait les questions réutilisées
        // → suppression en cascade de leurs Submission). On retire UNIQUEMENT les questions
        // réellement supprimées, et on met à jour / ajoute le reste en place.
        current.removeIf(q -> q.getId() != null && !keptIds.contains(q.getId()));

        int index = 0;
        for (QuestionDTO qd : dtos) {
            Question q;
            if (qd.getId() != null && existingById.containsKey(qd.getId())) {
                q = existingById.get(qd.getId()); // réutilisée → ses Submission sont préservées
            } else {
                q = new Question();
                current.add(q);
            }
            applyQuestionFields(q, qd, index, quiz);
            index++;
        }

        Quiz saved = quizRepository.save(quiz);
        Course course = quiz.getCourse();
        String details = AuditContext.ofChildOfCourse(course);
        auditLogService.record("QUIZ_UPDATE", "QUIZ", quizId,
                "Quiz « " + quiz.getTitle() + " » mis à jour", details);
        broadcastQuiz(saved.getCourse(), saved.getId(), true); // updated
        return toQuizDetailDTO(saved, true); // éditeur → renvoie la correction
    }

    /** Supprime un quiz et tout son contenu (cascade). */
    @Transactional
    public void deleteQuiz(Integer quizId) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        // Autorisation PAR RÔLE déléguée au permission-service (règle DELETE /quizzes/{quizId}).
        Course course = quiz.getCourse();
        // Capture les programmes AVANT delete (la collection lazy serait vidée après).
        List<Integer> programIds = course == null || course.getPrograms() == null ? List.of()
                : course.getPrograms().stream().map(Program::getId).toList();
        Integer courseId = course == null ? null : course.getId();
        String title = quiz.getTitle(); // capturé avant delete
        String details = AuditContext.ofChildOfCourse(course); // capturé avant delete
        quizRepository.delete(quiz);
        auditLogService.record("QUIZ_DELETE", "QUIZ", quizId,
                title != null ? "Quiz « " + title + " » supprimé" : "Quiz #" + quizId + " supprimé", details);
        if (courseId != null) {
            afterCommit(() -> {
                for (Integer programId : programIds) {
                    realtimePublisher.quizDeleted(programId, courseId, quizId);
                }
            });
        }
    }

    /** Diffuse l'ajout/la modif d'un quiz à toutes les rooms des programmes du cours. */
    private void broadcastQuiz(Course course, Integer quizId, boolean updated) {
        if (course == null || course.getPrograms() == null || quizId == null) return;
        Integer courseId = course.getId();
        // Capturé DANS la transaction (collection lazy) ; émis APRÈS commit (cf. afterCommit).
        List<Integer> programIds = course.getPrograms().stream().map(Program::getId).toList();
        afterCommit(() -> {
            for (Integer programId : programIds) {
                if (updated) {
                    realtimePublisher.quizUpdated(programId, courseId, quizId);
                } else {
                    realtimePublisher.quizCreated(programId, courseId, quizId);
                }
            }
        });
    }

    /**
     * Exécute l'action APRÈS le commit de la transaction courante (ou tout de suite hors
     * transaction). Évite la race « event diffusé avant commit » : un client qui re-fetch à
     * la réception verrait sinon l'ANCIEN état (ex. quiz encore brouillon).
     */
    private void afterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    action.run();
                }
            });
        } else {
            action.run();
        }
    }

    /** Réordonne les quiz d'un cours : `quizIds` dans le nouvel ordre → position 0..n. */
    @Transactional
    public void reorderQuizzes(Integer courseId, List<Integer> quizIds) {
        // Autorisation PAR RÔLE déléguée au permission-service (règle PATCH /courses/{id}/quizzes/reorder).
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

        // Capturé dans la transaction ; émis après commit (cf. afterCommit).
        List<Integer> programIds = course.getPrograms() == null ? List.of()
                : course.getPrograms().stream().map(Program::getId).toList();
        afterCommit(() -> {
            for (Integer programId : programIds) {
                realtimePublisher.quizReordered(programId, courseId);
            }
        });
    }

    // ── Soumission / correction ──────────────────────────────────────────────────

    /**
     * Soumet une tentative de façon ASYNCHRONE. Cette méthode ne fait que PERSISTER la tentative en
     * statut {@code "pending"} avec les réponses brutes (tx courte écriture) puis rend la main : le
     * contrôleur répond 202 + l'id de tentative. La correction du code — lente (sandbox) — se fait
     * ensuite en tâche de fond ({@link #gradeAttempt}), déclenchée APRÈS commit via un évènement, et
     * le résultat est poussé par WebSocket ({@code quiz:attempt-graded} / {@code -failed}).
     *
     * <p>Pourquoi async : le sandbox prend plusieurs secondes et ne doit tenir NI la requête HTTP
     * (risque de timeout proxy) NI une connexion BD (pool partagé). Tentative unique : 409 si déjà
     * soumise (quiz sans reprise) ou si une correction est déjà en cours (index partiel
     * {@code uq_attempt_pending}). `userEmail` vient du JWT (header gateway).
     */
    public Integer submitQuiz(Integer quizId, QuizSubmissionDTO submission, String userEmail) {
        Map<Integer, SubmittedAnswerDTO> byQuestion = toAnswerMap(submission.getAnswers());
        TransactionTemplate writeTx = new TransactionTemplate(transactionManager);
        return writeTx.execute(status -> persistPendingAttempt(quizId, userEmail, byQuestion));
    }

    /** Une question Code à vérifier, DÉTACHÉE du quiz (utilisable hors transaction). */
    private record CodeVerificationTask(
            Integer questionId, String language, String code,
            List<Integer> testCaseIds, List<ExecutionClient.Harness> harnesses) {}

    /** Contexte détaché d'une correction async : à qui pousser + quoi exécuter. */
    private record GradingContext(Integer userId, Integer quizId, List<CodeVerificationTask> tasks) {}

    /**
     * (tx écriture) Crée la tentative {@code "pending"} + une {@link Submission} brute par question
     * (réponses, SANS verdicts encore) et déclenche la correction async après commit.
     *
     * <p>Anti-double-soumission ATOMIQUE : la contrainte {@code UNIQUE(quiz,user,attempt_no)} ET
     * l'index partiel {@code uq_attempt_pending} garantissent qu'un seul pending existe à la fois —
     * un 2e insert concurrent viole l'un d'eux → {@link AlreadySubmittedException} (409).
     */
    private Integer persistPendingAttempt(Integer quizId, String userEmail,
            Map<Integer, SubmittedAnswerDTO> byQuestion) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);

        long existing = attemptRepository.countByQuiz_IdAndUser_Id(quizId, user.getId());
        if (existing > 0 && !Boolean.TRUE.equals(quiz.getAllowRetry())) {
            throw new AlreadySubmittedException();
        }

        Attempt attempt = new Attempt();
        attempt.setQuiz(quiz);
        attempt.setUser(user);
        attempt.setAttemptNo((int) existing + 1);
        attempt.setStatus("pending");
        Attempt saved;
        try {
            saved = attemptRepository.saveAndFlush(attempt);
        } catch (DataIntegrityViolationException e) {
            // UNIQUE(quiz,user,attempt_no) OU uq_attempt_pending (correction déjà en cours) → 409.
            throw new AlreadySubmittedException();
        }

        // Réponses brutes ; les verdicts de code seront ajoutés par la correction async.
        for (Question q : sortedQuestions(quiz)) {
            Submission s = new Submission();
            s.setAttempt(saved);
            s.setUser(user);
            s.setQuestion(q);
            s.setContent(serializeAnswer(byQuestion.get(q.getId())));
            submissionRepository.save(s);
        }

        // Correction lancée APRÈS commit (l'entité pending doit être visible du job) : évènement
        // transactionnel @AfterCommit + @Async (cf. QuizGradingListener).
        eventPublisher.publishEvent(new AttemptSubmittedEvent(saved.getId()));
        return saved.getId();
    }

    /**
     * Corrige une tentative {@code "pending"} : exécute les harnais de code HORS transaction (lent),
     * puis FINALISE en {@code "done"} + pousse {@code quiz:attempt-graded}.
     *
     * <p><b>TOUTE défaillance</b> (sandbox indisponible, erreur inattendue, échec de finalisation)
     * SUPPRIME la tentative pending et pousse {@code quiz:attempt-failed} : on ne laisse JAMAIS un
     * {@code "pending"} coincé, sinon l'index {@code uq_attempt_pending} verrouillerait tout renvoi.
     * La tentative unique n'est donc pas consommée. Appelée en async après commit (cf.
     * QuizGradingListener) ; publique pour passer par le proxy Spring (l'@Async ne marche pas en
     * self-invocation).
     */
    public void gradeAttempt(Integer attemptId) {
        GradingContext ctx;
        Map<Integer, Map<Integer, Boolean>> verdicts;
        try {
            // (1) tx courte lecture : contexte détaché (à qui pousser + quoi exécuter).
            TransactionTemplate readOnlyTx = new TransactionTemplate(transactionManager);
            readOnlyTx.setReadOnly(true);
            ctx = readOnlyTx.execute(status -> loadGradingContext(attemptId));
            if (ctx == null) return; // tentative disparue entre-temps

            // (2) sandbox HORS transaction : aucune connexion BD tenue pendant cette I/O lente.
            verdicts = runCodeVerification(ctx.tasks());

            // (3) persiste les verdicts + passe en "done" (transactionnel : un échec ici annule tout
            // et laisse la tentative en "pending" → traité comme une défaillance ci-dessous).
            TransactionTemplate writeTx = new TransactionTemplate(transactionManager);
            writeTx.executeWithoutResult(status -> finalizeAttempt(attemptId, verdicts));
        } catch (RuntimeException e) {
            failGrading(attemptId, e);
            return;
        }

        // Tentative "done" COMMITTÉE : le push est best-effort — une erreur WS ne doit PAS supprimer
        // une tentative valide déjà corrigée.
        try {
            realtimePublisher.quizAttemptGraded(ctx.userId(), ctx.quizId(), attemptId);
        } catch (RuntimeException e) {
            log.error("Push quiz:attempt-graded échoué pour la tentative {} (déjà corrigée)", attemptId, e);
        }
    }

    /**
     * Défaillance de correction : SUPPRIME la tentative pending (jamais de pending coincé) et notifie
     * l'auteur ({@code quiz:attempt-failed}). Seule la suppression est CRITIQUE ; le lookup du
     * destinataire et le push sont best-effort (à défaut, le front retombe sur son polling). Une
     * {@link CodeVerificationUnavailableException} est attendue (sandbox indisponible) ; toute autre
     * exception est un incident, journalisé.
     */
    private void failGrading(Integer attemptId, RuntimeException cause) {
        if (!(cause instanceof CodeVerificationUnavailableException)) {
            log.error("Correction de la tentative {} en échec inattendu : suppression du pending",
                    attemptId, cause);
        }
        long[] who = null;
        try {
            TransactionTemplate readTx = new TransactionTemplate(transactionManager);
            readTx.setReadOnly(true);
            who = readTx.execute(status -> {
                Attempt a = attemptRepository.findById(attemptId).orElse(null);
                return a == null ? null : new long[] {a.getUser().getId(), a.getQuiz().getId()};
            });
        } catch (RuntimeException ignore) {
            // Destinataire introuvable : on pousse pas d'event, le front récupère par polling.
        }
        TransactionTemplate delTx = new TransactionTemplate(transactionManager);
        delTx.executeWithoutResult(status -> attemptRepository.deleteById(attemptId));
        if (who != null) {
            realtimePublisher.quizAttemptFailed(who[0], who[1], attemptId, null);
        }
    }

    /**
     * (tx lecture) Reconstruit le contexte de correction depuis la tentative PERSISTÉE : le code de
     * chaque question vient de sa {@link Submission}. {@code null} si la tentative n'existe plus.
     */
    private GradingContext loadGradingContext(Integer attemptId) {
        Attempt attempt = attemptRepository.findById(attemptId).orElse(null);
        if (attempt == null) return null;
        Quiz quiz = attempt.getQuiz();
        Map<Integer, SubmittedAnswerDTO> byQuestion = new HashMap<>();
        for (Submission s : attempt.getSubmissions()) {
            byQuestion.put(s.getQuestion().getId(),
                    deserializeAnswer(s.getContent(), s.getQuestion().getId()));
        }
        return new GradingContext(attempt.getUser().getId(), quiz.getId(), buildCodeTasks(quiz, byQuestion));
    }

    /**
     * Prépare la liste des questions Code à exécuter, en capturant tout ce dont le sandbox a besoin
     * (langage, harnais, code soumis) dans des records DÉTACHÉS — exécutables hors transaction.
     */
    private List<CodeVerificationTask> buildCodeTasks(Quiz quiz, Map<Integer, SubmittedAnswerDTO> byQuestion) {
        List<CodeVerificationTask> tasks = new ArrayList<>();
        for (Question question : sortedQuestions(quiz)) {
            if (!"coding".equals(slugFor(question))) continue;
            List<TestCase> harnesses = orderedTestCases(question);
            if (harnesses.isEmpty()) continue;

            String language = question.getLanguage() != null ? question.getLanguage().getName() : null;
            SubmittedAnswerDTO answer = byQuestion.get(question.getId());
            String code = answer != null ? answer.getCode() : null;
            List<Integer> testCaseIds = harnesses.stream().map(TestCase::getId).toList();
            List<ExecutionClient.Harness> inputs = harnesses.stream()
                    .map(tc -> new ExecutionClient.Harness(tc.getName(), tc.getHarnessCode(), weightOf(tc)))
                    .toList();
            tasks.add(new CodeVerificationTask(question.getId(), language, code, testCaseIds, inputs));
        }
        return tasks;
    }

    /**
     * Exécute SYNCHRONEMENT (mais HORS transaction) les harnais de chaque question Code et renvoie
     * les verdicts par question ({@code questionId → (testCaseId → réussi)}). Lève
     * {@link CodeVerificationUnavailableException} dès qu'une question ne peut pas être évaluée
     * (service injoignable, réponse incohérente) : la soumission est alors refusée sans rien persister.
     */
    private Map<Integer, Map<Integer, Boolean>> runCodeVerification(List<CodeVerificationTask> tasks) {
        Map<Integer, Map<Integer, Boolean>> verdictsByQuestion = new HashMap<>();
        for (CodeVerificationTask task : tasks) {
            List<Boolean> verdicts = executionClient.evaluate(task.language(), task.code(), task.harnesses());
            if (verdicts == null || verdicts.size() != task.testCaseIds().size()) {
                throw new CodeVerificationUnavailableException();
            }
            Map<Integer, Boolean> byTestCase = new HashMap<>();
            for (int i = 0; i < task.testCaseIds().size(); i++) {
                byTestCase.put(task.testCaseIds().get(i), Boolean.TRUE.equals(verdicts.get(i)));
            }
            verdictsByQuestion.put(task.questionId(), byTestCase);
        }
        return verdictsByQuestion;
    }

    /**
     * (tx écriture) Finalise une tentative corrigée : persiste les verdicts de code
     * ({@code Submission_Test_Case}) à partir des soumissions déjà enregistrées, puis passe la
     * tentative en {@code "done"}. Aucun score n'est stocké : il est recalculé à la lecture
     * ({@link #computeAttemptResult}).
     */
    private void finalizeAttempt(Integer attemptId, Map<Integer, Map<Integer, Boolean>> codeVerdicts) {
        Attempt attempt = attemptRepository.findById(attemptId)
                .orElseThrow(AttemptNotFoundException::new);
        for (Submission s : attempt.getSubmissions()) {
            Map<Integer, Boolean> verdicts = codeVerdicts.get(s.getQuestion().getId());
            if (verdicts == null) continue;
            for (TestCase testCase : orderedTestCases(s.getQuestion())) {
                Boolean passed = verdicts.get(testCase.getId());
                if (passed == null) continue;
                SubmissionTestCase verdict = new SubmissionTestCase();
                verdict.setSubmission(s);
                verdict.setTestCase(testCase);
                verdict.setPassed(passed);
                submissionTestCaseRepository.save(verdict);
            }
        }
        attempt.setStatus("done");
        attemptRepository.save(attempt);
    }

    private static int weightOf(TestCase testCase) {
        return testCase.getWeight() != null && testCase.getWeight() > 0 ? testCase.getWeight() : 1;
    }

    /**
     * Historique des tentatives (résumés). earned/max sont calculés DYNAMIQUEMENT à partir
     * du quiz COURANT (pas de valeur figée en base) : `max` = barème des questions actuelles
     * (une question ajoutée augmente le total, une supprimée le diminue), `earned` = somme
     * des points obtenus sur les soumissions de la tentative (une question ajoutée, non
     * répondue, vaut 0).
     */
    @Transactional(readOnly = true)
    public List<AttemptSummaryDTO> getMyAttempts(Integer quizId, String userEmail) {
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);
        return attemptRepository.findByQuiz_IdAndUser_IdOrderByAttemptNoAsc(quizId, user.getId()).stream()
                // Les tentatives en cours de correction ("pending") ne font pas partie de l'historique.
                .filter(a -> "done".equals(a.getStatus()))
                .map(a -> {
                    QuizResultDTO r = computeAttemptResult(a);
                    return new AttemptSummaryDTO(
                            a.getId(),
                            a.getAttemptNo(),
                            r.getEarned(),
                            r.getMax(),
                            a.getSubmittedAt() == null ? null : a.getSubmittedAt().toInstant(ZoneOffset.UTC));
                })
                .toList();
    }

    /** Résultat corrigé d'UNE tentative donnée (révision), restreint à son propriétaire. */
    @Transactional(readOnly = true)
    public QuizResultDTO getAttemptResult(Integer attemptId, String userEmail) {
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);
        Attempt attempt = attemptRepository.findByIdAndUser_Id(attemptId, user.getId())
                .orElseThrow(AttemptNotFoundException::new);
        return computeAttemptResult(attempt);
    }

    /**
     * Agrégat de réussite aux quiz d'un COURS (pour l'analyse MCP) : re-note chaque tentative
     * via {@link #computeAttemptResult} et moyenne les % par tentative. Les questions de CODE
     * sont EXCLUES (core ne les note pas : elles compteraient 0 et fausseraient la moyenne ;
     * leur réussite est mesurée séparément via les tests). Aucune note n'est stockée.
     */
    @Transactional(readOnly = true)
    public CourseQuizStatsDTO getCourseQuizStats(Integer courseId) {
        List<Attempt> attempts = attemptRepository.findByQuiz_Course_Id(courseId);
        List<Double> percentages = new ArrayList<>();
        Set<Integer> students = new HashSet<>();
        for (Attempt attempt : attempts) {
            // Ignore les tentatives en cours de correction ("pending", verdicts pas encore écrits).
            if (!"done".equals(attempt.getStatus())) continue;
            Set<Integer> codeQuestionIds = sortedQuestions(attempt.getQuiz()).stream()
                    .filter(q -> "coding".equals(slugFor(q)))
                    .map(Question::getId)
                    .collect(Collectors.toSet());
            QuizResultDTO result = computeAttemptResult(attempt);
            double earned = 0;
            double max = 0;
            for (QuestionResultDTO qr : result.getQuestions()) {
                if (codeQuestionIds.contains(qr.getQuestionId())) continue;
                earned += qr.getEarned();
                max += qr.getMax();
            }
            if (max > 0) {
                percentages.add(100.0 * earned / max);
                students.add(attempt.getUser().getId());
            }
        }
        Integer average = percentages.isEmpty()
                ? null
                : (int) Math.round(percentages.stream().mapToDouble(Double::doubleValue).average().orElse(0));
        return new CourseQuizStatsDTO(average, percentages.size(), students.size());
    }

    /**
     * Corrige une tentative DYNAMIQUEMENT à partir du quiz COURANT : on (re)corrige chaque
     * question actuelle avec la réponse soumise (désérialisée). Une question ajoutée après la
     * tentative apparaît non répondue (0 / barème) ; une question supprimée n'y est plus.
     * Aucun score n'est lu en base : tout est recalculé.
     */
    private QuizResultDTO computeAttemptResult(Attempt attempt) {
        List<Submission> subs = attempt.getSubmissions() == null ? List.of() : attempt.getSubmissions();
        Map<Integer, SubmittedAnswerDTO> byQuestion = subs.stream()
                .collect(Collectors.toMap(
                        s -> s.getQuestion().getId(),
                        s -> deserializeAnswer(s.getContent(), s.getQuestion().getId()),
                        (a, b) -> a));
        // Verdicts Code PERSISTÉS (Submission_Test_Case) relus par question, même forme que la
        // map fraîche produite à la soumission.
        Map<Integer, Map<Integer, Boolean>> codeVerdicts = new HashMap<>();
        for (Submission s : subs) {
            if (s.getTestCaseResults() == null || s.getTestCaseResults().isEmpty()) continue;
            Map<Integer, Boolean> byTestCase = new HashMap<>();
            for (SubmissionTestCase verdict : s.getTestCaseResults()) {
                byTestCase.put(verdict.getTestCase().getId(), Boolean.TRUE.equals(verdict.getPassed()));
            }
            codeVerdicts.put(s.getQuestion().getId(), byTestCase);
        }

        QuizResultDTO result = buildResult(attempt.getQuiz(), byQuestion, codeVerdicts);
        result.setAttemptId(attempt.getId());
        result.setAttemptNo(attempt.getAttemptNo());
        return result;
    }

    private Map<Integer, SubmittedAnswerDTO> toAnswerMap(List<SubmittedAnswerDTO> answers) {
        return (answers == null ? List.<SubmittedAnswerDTO>of() : answers).stream()
                .collect(Collectors.toMap(SubmittedAnswerDTO::getQuestionId, a -> a, (a, b) -> a));
    }

    /**
     * Corrige toutes les questions du quiz. {@code codeVerdictsByQuestion} porte les verdicts
     * des questions Code ({@code testCaseId → réussi}), qu'ils soient frais (soumission) ou
     * persistés (lecture). Absent pour une question Code → « en cours » (tests = null).
     */
    private QuizResultDTO buildResult(Quiz quiz, Map<Integer, SubmittedAnswerDTO> byQuestion,
            Map<Integer, Map<Integer, Boolean>> codeVerdictsByQuestion) {
        List<QuestionResultDTO> results = sortedQuestions(quiz).stream()
                .map(q -> gradeQuestion(q, byQuestion.get(q.getId()), codeVerdictsByQuestion.get(q.getId())))
                .toList();
        return QuizResultDTO.builder()
                .quizId(quiz.getId())
                .earned(round1(results.stream().mapToDouble(QuestionResultDTO::getEarned).sum()))
                .max(round1(results.stream().mapToDouble(QuestionResultDTO::getMax).sum()))
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

    private QuestionResultDTO gradeQuestion(
            Question question, SubmittedAnswerDTO answer, Map<Integer, Boolean> codeVerdicts) {
        String slug = slugFor(question);
        if (slug == null) slug = "";
        return switch (slug) {
            case "true_false", "single_choice", "multiple_choice" -> gradeChoice(question, answer, slug);
            case "ordering" -> gradeOrdering(question, answer);
            case "matching" -> gradeMatching(question, answer);
            case "coding" -> gradeCoding(question, codeVerdicts);
            default -> CodeGrading.pending(question);
        };
    }

    /**
     * Note une question Code à partir de ses verdicts ({@code testCaseId → réussi}). Sans verdict
     * (question Code jamais évaluée) → « en cours » (tests = null).
     */
    private QuestionResultDTO gradeCoding(Question question, Map<Integer, Boolean> codeVerdicts) {
        List<TestCase> harnesses = orderedTestCases(question);
        return CodeGrading.build(question, harnesses, codeVerdicts == null ? Map.of() : codeVerdicts);
    }

    private static List<TestCase> orderedTestCases(Question question) {
        if (question.getTestCases() == null) return List.of();
        return question.getTestCases().stream()
                .sorted(Comparator.comparing(TestCase::getId, Comparator.nullsLast(Comparator.naturalOrder())))
                .toList();
    }

    private QuestionResultDTO gradeChoice(Question question, SubmittedAnswerDTO answer, String slug) {
        List<Answer> options = question.getAnswers() == null ? List.of() : question.getAnswers();
        List<Integer> correctIds = options.stream()
                .filter(o -> Boolean.TRUE.equals(o.getIsCorrect()))
                .map(Answer::getId).toList();
        List<Integer> selectedIds = answer != null && answer.getAnswerIds() != null
                ? answer.getAnswerIds() : List.of();
        Set<Integer> correctSet = new HashSet<>(correctIds);

        double total = question.getTotalScore() != null ? question.getTotalScore() : 0.0;
        double earned;
        if ("multiple_choice".equals(slug)) {
            long good = selectedIds.stream().filter(correctSet::contains).count();
            long bad = selectedIds.stream().filter(id -> !correctSet.contains(id)).count();
            double ratio = correctIds.isEmpty() ? 0 : (double) (good - bad) / correctIds.size();
            earned = scaled(total, ratio);
        } else {
            Set<Integer> selectedSet = new HashSet<>(selectedIds);
            boolean exact = selectedSet.equals(correctSet);
            earned = exact ? total : 0.0;
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

    /** Score proportionnel borné, arrondi au DIXIÈME : total × clamp(ratio, 0, 1). Package-private
     *  (au lieu de private) pour être testable directement. */
    static double scaled(double total, double ratio) {
        return round1(total * Math.max(0, Math.min(1, ratio)));
    }

    /** Arrondi au dixième (les scores de question sont au format X.X). */
    static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
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
            q.setTotalScore(qd.getTotalScore() != null ? qd.getTotalScore() : 0.0);
            q.setQType(resolveQType(qd));
            q.setLanguage(resolveLanguage(qd));
            q.setAnswers(buildAnswers(qd.getAnswers(), q));
            q.setDragItems(buildDragItems(qd.getDragItems(), q));
            q.setTestCases(buildTestCases(qd.getTestCases(), q));
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

    /** Applique les champs d'un QuestionDTO sur une question (existante ou neuve), en place. */
    private void applyQuestionFields(Question q, QuestionDTO qd, int index, Quiz quiz) {
        q.setQuiz(quiz);
        q.setPrompt(qd.getPrompt());
        q.setStartCode(qd.getStartCode());
        q.setOrderIndex(qd.getOrderIndex() != null ? qd.getOrderIndex() : index);
        q.setTotalScore(qd.getTotalScore() != null ? qd.getTotalScore() : 0.0);
        q.setQType(resolveQType(qd));
        q.setLanguage(resolveLanguage(qd));
        applyAnswers(q, qd.getAnswers());
        applyDragItems(q, qd.getDragItems());
        applyTestCases(q, qd.getTestCases());
    }

    /** Résout le langage d'une question Code depuis le DTO (id imbriqué). null si absent/non-code. */
    private Language resolveLanguage(QuestionDTO qd) {
        if (qd.getLanguage() == null || qd.getLanguage().getId() == null) return null;
        return languageRepository.findById(qd.getLanguage().getId())
                .orElseThrow(() -> new IllegalArgumentException(
                        "Langage inconnu: " + qd.getLanguage().getId()));
    }

    /**
     * Met à jour les options d'une question en RÉUTILISANT les Answer existantes par id
     * (les ids restent stables → une réponse d'étudiant en cours n'est pas invalidée au
     * rechargement). Seules les options réellement retirées sont supprimées.
     */
    private void applyAnswers(Question q, List<AnswerDTO> dtos) {
        if (q.getAnswers() == null) q.setAnswers(new ArrayList<>());
        List<Answer> current = q.getAnswers();
        Map<Integer, Answer> existingById = current.stream()
                .filter(a -> a.getId() != null)
                .collect(Collectors.toMap(Answer::getId, a -> a));
        List<AnswerDTO> list = dtos == null ? List.of() : dtos;
        Set<Integer> keptIds = list.stream()
                .map(AnswerDTO::getId)
                .filter(id -> id != null && existingById.containsKey(id))
                .collect(Collectors.toSet());
        current.removeIf(a -> a.getId() != null && !keptIds.contains(a.getId()));
        for (AnswerDTO ad : list) {
            Answer a;
            if (ad.getId() != null && existingById.containsKey(ad.getId())) {
                a = existingById.get(ad.getId()); // réutilisée → id stable
            } else {
                a = new Answer();
                a.setQuestion(q);
                current.add(a);
            }
            a.setContent(ad.getContent());
            a.setIsCorrect(Boolean.TRUE.equals(ad.getIsCorrect()));
        }
    }

    /** Idem pour les éléments déplaçables : réutilise les DragItem existants par id (ids stables). */
    private void applyDragItems(Question q, List<DragItemDTO> dtos) {
        if (q.getDragItems() == null) q.setDragItems(new ArrayList<>());
        List<DragItem> current = q.getDragItems();
        Map<Integer, DragItem> existingById = current.stream()
                .filter(d -> d.getId() != null)
                .collect(Collectors.toMap(DragItem::getId, d -> d));
        List<DragItemDTO> list = dtos == null ? List.of() : dtos;
        Set<Integer> keptIds = list.stream()
                .map(DragItemDTO::getId)
                .filter(id -> id != null && existingById.containsKey(id))
                .collect(Collectors.toSet());
        current.removeIf(d -> d.getId() != null && !keptIds.contains(d.getId()));
        for (DragItemDTO dd : list) {
            DragItem d;
            if (dd.getId() != null && existingById.containsKey(dd.getId())) {
                d = existingById.get(dd.getId()); // réutilisé → id stable
            } else {
                d = new DragItem();
                d.setQuestion(q);
                current.add(d);
            }
            d.setContent(dd.getContent());
            d.setCorrectOrder(dd.getCorrectOrder() != null ? dd.getCorrectOrder() : 0);
            d.setGroupName(dd.getGroupName());
        }
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

    private List<TestCase> buildTestCases(List<TestCaseDTO> dtos, Question question) {
        List<TestCase> testCases = new ArrayList<>();
        if (dtos == null) return testCases;
        for (TestCaseDTO td : dtos) {
            TestCase tc = new TestCase();
            tc.setName(td.getName());
            tc.setHarnessCode(td.getHarnessCode());
            tc.setWeight(td.getWeight() != null ? td.getWeight() : 1);
            tc.setQuestion(question);
            testCases.add(tc);
        }
        return testCases;
    }

    /** Idem pour les harnais : réutilise les Test_Case existants par id (ids stables). */
    private void applyTestCases(Question q, List<TestCaseDTO> dtos) {
        if (q.getTestCases() == null) q.setTestCases(new ArrayList<>());
        List<TestCase> current = q.getTestCases();
        Map<Integer, TestCase> existingById = current.stream()
                .filter(tc -> tc.getId() != null)
                .collect(Collectors.toMap(TestCase::getId, tc -> tc));
        List<TestCaseDTO> list = dtos == null ? List.of() : dtos;
        Set<Integer> keptIds = list.stream()
                .map(TestCaseDTO::getId)
                .filter(id -> id != null && existingById.containsKey(id))
                .collect(Collectors.toSet());
        current.removeIf(tc -> tc.getId() != null && !keptIds.contains(tc.getId()));
        for (TestCaseDTO td : list) {
            TestCase tc;
            if (td.getId() != null && existingById.containsKey(td.getId())) {
                tc = existingById.get(td.getId()); // réutilisé → id stable
            } else {
                tc = new TestCase();
                tc.setQuestion(q);
                current.add(tc);
            }
            tc.setName(td.getName());
            tc.setHarnessCode(td.getHarnessCode());
            tc.setWeight(td.getWeight() != null ? td.getWeight() : 1);
        }
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

    /**
     * @param includeCorrection true pour l'ÉDITEUR (expose isCorrect/correctOrder/groupName),
     *                           false pour la PASSATION (ces champs restent null → omis du JSON).
     */
    private QuizDetailDTO toQuizDetailDTO(Quiz quiz, boolean includeCorrection) {
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
                        .map(q -> toQuestionDTO(q, includeCorrection))
                        .toList())
                .build();
    }

    private QuestionDTO toQuestionDTO(Question question, boolean includeCorrection) {
        return QuestionDTO.builder()
                .id(question.getId())
                .prompt(question.getPrompt())
                .qType(slugFor(question))
                .qTypeId(question.getQType() != null ? question.getQType().getId() : null)
                .totalScore(question.getTotalScore())
                .orderIndex(question.getOrderIndex())
                // Langage LIGHT (id + name) : suffit à la coloration et à pré-sélectionner
                // dans l'éditeur ; on n'expose pas les templates de harnais en passation.
                .language(question.getLanguage() == null ? null
                        : LanguageDTO.builder()
                        .id(question.getLanguage().getId())
                        .name(question.getLanguage().getName())
                        .build())
                .startCode(question.getStartCode())
                .answers(question.getAnswers() == null ? List.of()
                        : question.getAnswers().stream()
                        .map(a -> toAnswerDTO(a, includeCorrection)).toList())
                .dragItems(question.getDragItems() == null ? List.of()
                        : question.getDragItems().stream()
                        .map(d -> toDragItemDTO(d, includeCorrection)).toList())
                // Catégories (zones) d'une association : groupes DISTINCTS, exposés à l'étudiant
                // (les zones de dépôt) — le groupe correct de chaque item reste, lui, masqué.
                .groups(distinctGroups(question))
                // Harnais : ÉDITEUR seulement. En passation → null (omis) : code des tests caché.
                .testCases(includeCorrection && question.getTestCases() != null
                        ? question.getTestCases().stream().map(this::toTestCaseDTO).toList()
                        : null)
                .build();
    }

    private TestCaseDTO toTestCaseDTO(TestCase testCase) {
        return TestCaseDTO.builder()
                .id(testCase.getId())
                .name(testCase.getName())
                .harnessCode(testCase.getHarnessCode())
                .weight(testCase.getWeight())
                .build();
    }

    private String slugFor(Question question) {
        if (question.getQType() == null) return null;
        return Q_TYPE_NAME_TO_SLUG.get(question.getQType().getName());
    }

    private AnswerDTO toAnswerDTO(Answer answer, boolean includeCorrection) {
        return AnswerDTO.builder()
                .id(answer.getId())
                .content(answer.getContent())
                // Passation : null → champ omis (cf. @JsonInclude NON_NULL).
                .isCorrect(includeCorrection ? answer.getIsCorrect() : null)
                .build();
    }

    private DragItemDTO toDragItemDTO(DragItem dragItem, boolean includeCorrection) {
        return DragItemDTO.builder()
                .id(dragItem.getId())
                .content(dragItem.getContent())
                // Passation : null → champs omis (cf. @JsonInclude NON_NULL).
                .correctOrder(includeCorrection ? dragItem.getCorrectOrder() : null)
                .groupName(includeCorrection ? dragItem.getGroupName() : null)
                .build();
    }

    /**
     * Catégories DISTINCTES (zones de dépôt) d'une association. TRIÉES ALPHABÉTIQUEMENT à dessein :
     * l'ordre d'apparition des items corrélerait avec l'ordre des items (non mélangés) et révélerait
     * le mapping item→groupe. Le tri décorrèle l'ordre affiché de la solution.
     */
    static List<String> distinctGroups(Question question) {
        if (question.getDragItems() == null) {
            return List.of();
        }
        return question.getDragItems().stream()
                .map(DragItem::getGroupName)
                .filter(g -> g != null && !g.isBlank())
                .distinct()
                .sorted()
                .toList();
    }
}
