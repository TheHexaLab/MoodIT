package com.moodit.core_service.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.AlreadySubmittedException;
import com.moodit.core_service.exception.AttemptNotFoundException;
import com.moodit.core_service.exception.AttemptNotReviewableException;
import com.moodit.core_service.exception.CodeVerificationNoVerdictException;
import com.moodit.core_service.exception.CodeVerificationUnavailableException;
import com.moodit.core_service.exception.GradingInProgressException;
import com.moodit.core_service.exception.GradingInterruptedException;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.InvalidQuizException;
import com.moodit.core_service.exception.QuizNotFoundException;
import com.moodit.core_service.exception.RegradeInProgressException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.*;
import com.moodit.core_service.repository.AttemptRepository;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.GradingFailureRepository;
import com.moodit.core_service.repository.LanguageRepository;
import com.moodit.core_service.repository.QTypeRepository;
import com.moodit.core_service.repository.QuizRepository;
import com.moodit.core_service.repository.SubmissionRepository;
import com.moodit.core_service.repository.SubmissionTestCaseRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
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
import java.util.LinkedHashSet;
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
    private final QuizItemObfuscator itemObfuscator;
    private final GradingFailureRepository gradingFailureRepository;

    /**
     * Statut d'une tentative gardée « à revoir » par l'enseignant (#116, S4) : sa correction a
     * échoué et failGrading l'a gardée — relance par l'enseignant, ou plafond atteint sur un échec
     * sans verdict ou sur un quiz sans reprise.
     */
    public static final String REVIEW = "review";

    /**
     * Plafond des échecs de correction SANS VERDICT par étudiant et par quiz (#116, S4). En deçà,
     * la tentative échouée est supprimée et l'étudiant resoumet ; à partir de ce compte, elle est
     * gardée « à revoir ». Une sandbox simplement indisponible ne compte pas.
     */
    private int maxNoVerdictFailures = 3;

    /**
     * Au moins 1, vérifié au démarrage : 0 ne DÉSACTIVE pas le plafond, il le rend toujours
     * atteint — toute tentative en échec SANS VERDICT, et toute panne sur un quiz sans reprise,
     * serait gardée « à revoir » au lieu d'être resoumise par l'étudiant (revue #246).
     */
    @Value("${app.quiz.grading.max-no-verdict-failures:3}")
    void setMaxNoVerdictFailures(int maxNoVerdictFailures) {
        if (maxNoVerdictFailures < 1) {
            throw new IllegalArgumentException(
                    "app.quiz.grading.max-no-verdict-failures doit valoir au moins 1");
        }
        this.maxNoVerdictFailures = maxNoVerdictFailures;
    }

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

    /** Nombre minimal d'éléments d'une Remise en ordre (cf. requireValidOrderingItems). */
    static final int MIN_ORDERING_ITEMS = 3;

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
        // Vue ÉDITEUR : compteur des tentatives « à revoir » par quiz (#116, S4), en une requête.
        Map<Integer, Integer> toReview = new HashMap<>();
        if (!publishedOnly) {
            for (Object[] row : attemptRepository.countByStatusPerQuiz(courseId, REVIEW)) {
                toReview.put((Integer) row[0], ((Number) row[1]).intValue());
            }
        }
        return (course.getQuizzes() == null ? List.<Quiz>of() : course.getQuizzes()).stream()
                .filter(q -> !publishedOnly || Boolean.TRUE.equals(q.getIsPublished()))
                .sorted(Comparator.comparing(Quiz::getPosition,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .map(q -> {
                    QuizDTO dto = toQuizMetaDTO(q);
                    if (!publishedOnly) {
                        dto.setReviewAttemptCount(toReview.getOrDefault(q.getId(), 0));
                    }
                    return dto;
                })
                .toList();
    }

    /**
     * Détail d'un quiz pour la PASSATION (étudiant). Les champs de correction
     * (isCorrect, correctOrder, groupName) et les harnais (Test_Case) sont EXCLUS :
     * le client n'en a pas besoin (la correction se fait côté serveur) et les exposer
     * permettrait de tricher. Les éléments déplaçables sont mélangés et leurs ids masqués
     * (cf. {@link QuizItemObfuscator}).
     *
     * <p>Un BROUILLON n'existe pas en passation (404) : le personnel le consulte par la vue
     * éditeur ({@link #getQuizForEdit}), seule route qui le concerne (#28).
     */
    @Transactional(readOnly = true)
    public QuizDetailDTO getQuizDetail(Integer quizId) {
        return toQuizDetailDTO(findPublishedQuiz(quizId), false);
    }

    /** Quiz PUBLIÉ (passation : lecture, soumission) ; un brouillon est traité comme absent. */
    private Quiz findPublishedQuiz(Integer quizId) {
        Quiz quiz = quizRepository.findById(quizId)
                .orElseThrow(QuizNotFoundException::new);
        if (!Boolean.TRUE.equals(quiz.getIsPublished())) {
            throw new QuizNotFoundException();
        }
        return quiz;
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
     * (risque de timeout proxy) NI une connexion BD (pool partagé). Trois 409 distincts :
     * {@link GradingInProgressException} (corps JSON {@code cause = "en_cours"}) si une correction
     * d'une soumission de l'étudiant sur ce quiz est déjà en cours (tentative {@code "pending"},
     * index partiel {@code uq_attempt_pending}) — le frontend rejoint alors l'attente de la
     * tentative {@code attemptId} du corps (le pending existant, ou après un conflit d'insertion la
     * dernière tentative relue ; omis si elle a disparu ou si elle est plus ancienne que le numéro
     * que cette soumission a tenté d'insérer — concurrente supprimée entre-temps, ou relance d'une
     * ancienne tentative finie avant la relecture : ce n'est pas l'écriture concurrente) ;
     * {@link RegradeInProgressException} ({@code cause = "relance"}) si ce pending est une RELANCE
     * de l'enseignant ({@link Attempt#isRegrade()}) sur un quiz AVEC reprise, dont le verdict
     * n'est pas celui de cette soumission ; sinon {@link AlreadySubmittedException} (corps texte)
     * si la tentative unique est déjà consommée (quiz sans reprise — relance en cours comprise :
     * elle porte forcément sur cette tentative unique). `userEmail` vient du JWT (header gateway).
     */
    public Integer submitQuiz(Integer quizId, QuizSubmissionDTO submission, String userEmail) {
        Map<Integer, SubmittedAnswerDTO> byQuestion = toAnswerMap(submission.getAnswers());
        TransactionTemplate writeTx = new TransactionTemplate(transactionManager);
        try {
            return writeTx.execute(status -> persistPendingAttempt(quizId, userEmail, byQuestion));
        } catch (ConcurrentSubmissionException e) {
            // Insert refusé par une contrainte : une autre écriture CONCURRENTE a créé, pour le
            // même étudiant et le même quiz, une tentative pending (sa soumission, ou une relance
            // de l'enseignant). C'est donc TOUJOURS une correction en cours, jamais « déjà soumis »
            // : relire seulement le pending de l'autre écriture ne suffirait pas, car sur un quiz
            // sans harnais elle passe en done en quelques millisecondes (ou est supprimée) et la
            // relecture ne trouverait plus rien. Reste à distinguer la relance, relue dans une
            // transaction NOUVELLE : celle de l'insert est annulée — sous PostgreSQL, une
            // transaction en erreur refuse toute requête jusqu'à son rollback. Sur un quiz SANS
            // reprise, une relance concurrente est en pratique inatteignable ici (elle suppose une
            // tentative « à revoir », que le comptage aurait déjà refusée) ; si elle survenait,
            // la même règle que le contrôle préalable s'applique (cf. pendingConflict).
            // La tentative à attendre est celle de l'écriture concurrente : la DERNIÈRE de
            // l'étudiant sur ce quiz, pending ou déjà corrigée, à condition que son numéro soit au
            // moins celui que cette soumission a tenté d'insérer — ce numéro vient d'un comptage
            // fait AVANT la recherche du pending (cf. persistPendingAttempt) : une écriture
            // concurrente que cette recherche n'a pas vue a été validée après ce comptage, et
            // porte donc un numéro au moins égal. Plus ancienne, ce n'est PAS elle : la concurrente a été supprimée entre-temps (correction
            // abandonnée), ou c'était une relance d'une ANCIENNE tentative, finie avant la
            // relecture. Son id ferait ouvrir au client le résultat d'une autre tentative comme
            // celui de son envoi : il est omis, et le client retombe sur son repli.
            TransactionTemplate readTx = new TransactionTemplate(transactionManager);
            readTx.setReadOnly(true);
            throw readTx.execute(status -> pendingConflict(quizId, e.userId, e.allowRetry,
                    () -> attemptRepository.findFirstByQuiz_IdAndUser_IdOrderByAttemptNoDesc(quizId, e.userId)
                            .filter(a -> a.getAttemptNo() >= e.attemptNo)   // attempt_no NOT NULL
                            .map(Attempt::getId).orElse(null)));
        }
    }

    /**
     * 409 d'une soumission face au pending de l'étudiant sur ce quiz : « en_cours » pour la
     * correction de sa propre soumission, avec l'id de la tentative à attendre
     * ({@code inProgressAttemptId}, lu seulement dans ce cas ; {@code null} si inconnu) ; pour une
     * RELANCE de l'enseignant, « relance » sur un quiz avec reprise (il pourra resoumettre ensuite),
     * mais « déjà soumis » sur un quiz sans reprise — la relance porte forcément sur sa tentative
     * unique, « réessayez plus tard » le mènerait de toute façon à ce refus.
     */
    private RuntimeException pendingConflict(Integer quizId, Integer userId, boolean allowRetry,
            java.util.function.Supplier<Integer> inProgressAttemptId) {
        if (!attemptRepository.existsByQuiz_IdAndUser_IdAndStatusAndRegrade(quizId, userId, "pending", true)) {
            return new GradingInProgressException(inProgressAttemptId.get());
        }
        return allowRetry ? new RegradeInProgressException() : new AlreadySubmittedException();
    }

    /**
     * Insert de la tentative refusé par {@code UNIQUE(quiz,user,attempt_no)} ou
     * {@code uq_attempt_pending} (écriture concurrente du même étudiant sur le même quiz) :
     * {@link #submitQuiz} répond « correction en cours », sauf relance relue hors de la
     * transaction annulée (cf. {@link #pendingConflict}, d'où {@code allowRetry}).
     * {@code attemptNo} : le numéro que cette soumission a tenté d'insérer ; seule une tentative
     * relue de numéro au moins égal peut être celle de l'écriture concurrente.
     */
    private static final class ConcurrentSubmissionException extends RuntimeException {
        private final Integer userId;
        private final boolean allowRetry;
        private final int attemptNo;

        ConcurrentSubmissionException(Integer userId, boolean allowRetry, int attemptNo, Throwable cause) {
            super(cause);
            this.userId = userId;
            this.allowRetry = allowRetry;
            this.attemptNo = attemptNo;
        }
    }

    /** Une question Code à vérifier, DÉTACHÉE du quiz (utilisable hors transaction). */
    private record CodeVerificationTask(
            Integer questionId, String language, String code,
            List<Integer> testCaseIds, List<ExecutionClient.Harness> harnesses, Integer timeoutMs,
            String startCode) {}

    /** Contexte détaché d'une correction async : à qui pousser + quoi exécuter. */
    private record GradingContext(Integer userId, Integer quizId, List<CodeVerificationTask> tasks) {}

    /**
     * (tx écriture) Crée la tentative {@code "pending"} + une {@link Submission} brute par question
     * (réponses, SANS verdicts encore) et déclenche la correction async après commit.
     *
     * <p>Une tentative {@code "pending"} déjà là (correction en cours) est refusée AVANT le
     * contrôle de tentative unique : sur un quiz sans reprise, elle compte aussi parmi les
     * tentatives et donnerait sinon le 409 « déjà soumis » à tort. Le 409 suit
     * {@link #pendingConflict} : {@link GradingInProgressException} pour sa propre correction ;
     * pour une relance de l'enseignant, {@link RegradeInProgressException} avec reprise,
     * {@link AlreadySubmittedException} sans reprise.
     *
     * <p>Anti-double-soumission ATOMIQUE : la contrainte {@code UNIQUE(quiz,user,attempt_no)} ET
     * l'index partiel {@code uq_attempt_pending} garantissent qu'un seul pending existe à la fois —
     * un 2e insert concurrent viole l'un d'eux → {@link ConcurrentSubmissionException}, que
     * {@link #submitQuiz} traduit en 409 « en_cours » même si le pending concurrent est déjà
     * corrigé (ou supprimé) à la relecture ; seule une relance relue change la réponse.
     */
    private Integer persistPendingAttempt(Integer quizId, String userEmail,
            Map<Integer, SubmittedAnswerDTO> submitted) {
        // Un brouillon ne se soumet pas : la tentative unique n'est pas consommée avant l'ouverture.
        Quiz quiz = findPublishedQuiz(quizId);
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);
        // Le client répond avec les ids PUBLICS des éléments : on stocke et corrige sur les ids réels.
        Map<Integer, SubmittedAnswerDTO> byQuestion = unmaskItemIds(submitted);

        // Avant toute écriture : une réponse mal formée est refusée (400) sans consommer la tentative.
        requireValidOrderings(quiz, byQuestion);
        requireBoundedCode(quiz, byQuestion);

        // ORDRE : compter, PUIS chercher le pending, PUIS la tentative unique. En READ COMMITTED,
        // chaque SELECT voit les validations faites avant lui. Cherché AVANT le comptage, un
        // pending concurrent validé entre les deux échappait à la recherche mais entrait dans le
        // compte : numéro tenté trop grand (avec reprise, le conflit écartait ensuite la tentative
        // concurrente comme trop ancienne — 409 sans id) ou « déjà soumis » au lieu de « en
        // cours » (sans reprise). Dans cet ordre, une soumission concurrente validée avant ou
        // pendant est vue par la recherche ; validée après, elle a le même numéro que celui tenté
        // ici, et le conflit d'insertion la retrouve (cf. submitQuiz).
        long existing = attemptRepository.countByQuiz_IdAndUser_Id(quizId, user.getId());
        Optional<Attempt> pending = attemptRepository
                .findFirstByQuiz_IdAndUser_IdAndStatusOrderByAttemptNoDesc(quizId, user.getId(), "pending");
        if (pending.isPresent()) {
            Integer pendingId = pending.get().getId();
            throw pendingConflict(quizId, user.getId(), Boolean.TRUE.equals(quiz.getAllowRetry()),
                    () -> pendingId);
        }
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
            // UNIQUE(quiz,user,attempt_no) OU uq_attempt_pending : écriture concurrente. Le 409
            // est décidé hors de cette transaction, désormais inutilisable (cf. submitQuiz).
            throw new ConcurrentSubmissionException(
                    user.getId(), Boolean.TRUE.equals(quiz.getAllowRetry()), attempt.getAttemptNo(), e);
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
        // transactionnel @AfterCommit, puis pool selon la présence de harnais (cf. QuizGradingListener).
        eventPublisher.publishEvent(new AttemptSubmittedEvent(saved.getId(), needsSandbox(quiz)));
        return saved.getId();
    }

    /**
     * Vrai si la correction passera par execution-service : au moins une question Code avec des
     * harnais (même règle que {@link #buildCodeTasks}, qui ignore une question Code sans harnais).
     */
    private boolean needsSandbox(Quiz quiz) {
        for (Question question : sortedQuestions(quiz)) {
            if ("coding".equals(slugFor(question)) && !orderedTestCases(question).isEmpty()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Tentatives encore {@code "pending"} en BD, à relancer au démarrage de core (cf.
     * QuizGradingListener). Une correction vit seulement en mémoire, dans la file d'un executor :
     * un arrêt de core (déploiement, OOM, redémarrage de l'hôte) perd celles en file ou en cours,
     * et leurs tentatives resteraient {@code "pending"} pour toujours, l'index
     * {@code uq_attempt_pending} refusant alors toute resoumission. Chacune revient avec le pool
     * qui lui convient, comme à la soumission.
     */
    public List<AttemptSubmittedEvent> pendingGradings() {
        TransactionTemplate readOnlyTx = new TransactionTemplate(transactionManager);
        readOnlyTx.setReadOnly(true);
        List<AttemptSubmittedEvent> pending = readOnlyTx.execute(status ->
                attemptRepository.findByStatusOrderByIdAsc("pending").stream()
                        .map(a -> new AttemptSubmittedEvent(a.getId(), needsSandbox(a.getQuiz())))
                        .toList());
        return pending == null ? List.of() : pending;
    }

    /**
     * Abandonne une correction qui n'a pas pu être planifiée (executor saturé, cf.
     * QuizGradingListener) : même traitement qu'une défaillance de correction (failGrading) — la
     * tentative pending est supprimée et l'auteur prévenu, ou gardée « à revoir » selon les règles de
     * failGrading (relance par l'enseignant, ou plafond atteint sur un échec sans verdict ou sur un quiz sans reprise).
     */
    public void abandonGrading(Integer attemptId, RuntimeException cause) {
        failGrading(attemptId, cause);
    }

    /**
     * Corrige une tentative {@code "pending"} : exécute les harnais de code HORS transaction (lent),
     * puis FINALISE en {@code "done"} + pousse {@code quiz:attempt-graded}.
     *
     * <p><b>Toute défaillance</b> (sandbox indisponible, erreur inattendue, échec de finalisation)
     * passe par failGrading, qui pousse {@code quiz:attempt-failed} et SUPPRIME la tentative pending
     * (la tentative unique n'est pas consommée) ou la garde {@code "review"} (plafond d'échecs sans
     * verdict, tentative relancée par l'enseignant) : jamais un {@code "pending"} coincé, sinon
     * l'index {@code uq_attempt_pending} verrouillerait tout renvoi. Seule exception, l'ARRÊT de core
     * pendant la correction ({@link GradingInterruptedException}) : la tentative reste
     * {@code "pending"} et la reprise au démarrage la recorrige. Appelée après commit sur l'un des executors de
     * correction (cf. QuizGradingListener), hors de toute transaction.
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
            Boolean finalized = writeTx.execute(status -> finalizeAttempt(attemptId, verdicts));
            if (!Boolean.TRUE.equals(finalized)) {
                // Déjà corrigée par une autre passe (reprise au démarrage + soumission) : rien à
                // pousser, l'autre passe l'a fait.
                return;
            }
        } catch (GradingInterruptedException e) {
            // Arrêt de core pendant l'attente d'execution-service : seule exception à la règle
            // « jamais de pending coincé ». La tentative reste "pending" et sera reprise au
            // démarrage suivant (resumePendingGradings) ; la supprimer obligeait l'étudiant à
            // resoumettre alors qu'aucune correction n'avait commencé.
            log.warn("Correction de la tentative {} interrompue par l'arrêt : reprise au démarrage",
                    attemptId);
            return;
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
     *
     * <p>Plafond (#116, S4) : un échec SANS VERDICT ({@link CodeVerificationNoVerdictException} —
     * le conteneur a tourné sans rendre de verdict) est compté par étudiant et par quiz. Supprimer
     * la tentative offrait sinon un nouvel essai à volonté sur une question à tentative unique, à
     * tout code soumis capable de provoquer cet échec. Dès que le compte atteint
     * {@code app.quiz.grading.max-no-verdict-failures}, la tentative n'est plus supprimée : elle
     * reste en {@value #REVIEW}, « à revoir » par l'enseignant, et l'événement porte la raison
     * {@value #REVIEW}. Le compte n'est pas une note : l'enseignant relance la correction
     * ({@link #regradeAttempt}). Sur un quiz SANS reprise, une fois le plafond atteint, TOUT échec
     * garde aussi la tentative à revoir. Cas rare : après la tentative gardée au plafond,
     * l'étudiant ne peut plus soumettre et une relance est couverte par son marqueur (ci-dessous) ;
     * il reste un quiz dont la reprise a été retirée, ou un plafond abaissé dans la configuration,
     * pendant qu'une correction tournait. La tentative unique est alors consommée ou en jeu :
     * l'effacer sur une simple panne la rendrait à un étudiant déjà au plafond. Sur un quiz AVEC
     * reprise, une panne supprime la tentative comme d'habitude (l'étudiant resoumet ; la garder
     * ne ferait que charger l'enseignant). Une correction aboutie remet le compte à zéro (cf. finalizeAttempt).
     * Une tentative RELANCÉE par l'enseignant ({@link Attempt#isRegrade()}) revient à revoir quel
     * que soit l'échec et quel que soit le compte : sur un quiz avec reprise, une autre tentative
     * corrigée entre-temps a pu le remettre à zéro.
     */
    private void failGrading(Integer attemptId, RuntimeException cause) {
        boolean noVerdict = cause instanceof CodeVerificationNoVerdictException;
        if (!(cause instanceof CodeVerificationUnavailableException)) {
            log.error("Correction de la tentative {} en échec inattendu", attemptId, cause);
        }
        long[] who = null;
        try {
            // REQUIRES_NEW : depuis abandonGrading, on est encore dans le rappel after-commit de la
            // soumission, dont les ressources restent liées au thread. Une propagation REQUIRED
            // rejoindrait cette transaction déjà committée et la suppression ne serait jamais écrite.
            TransactionTemplate readTx = new TransactionTemplate(transactionManager);
            readTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            readTx.setReadOnly(true);
            who = readTx.execute(status -> {
                Attempt a = attemptRepository.findById(attemptId).orElse(null);
                return a == null ? null : new long[] {a.getUser().getId(), a.getQuiz().getId()};
            });
        } catch (RuntimeException ignore) {
            // Destinataire introuvable : on pousse pas d'event, le front récupère par polling.
        }
        // Suppression CONDITIONNELLE, sous verrou de ligne : seulement si la tentative est encore
        // "pending". Une tentative peut être corrigée deux fois (soumise pendant la reprise au
        // démarrage) : la passe perdante échoue sur la clé de Submission_Test_Case, et ne doit pas
        // supprimer la tentative que l'autre passe vient de finaliser en "done". Suppression par
        // l'entité : soumissions et verdicts partent par la cascade JPA.
        TransactionTemplate delTx = new TransactionTemplate(transactionManager);
        delTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        String outcome = delTx.execute(status -> attemptRepository.findByIdForUpdate(attemptId)
                .filter(a -> "pending".equals(a.getStatus()))
                .map(a -> {
                    int failures = noVerdictFailuresAfter(a, noVerdict);
                    // Une relance revient TOUJOURS à revoir : son compte a pu être remis à zéro
                    // par une autre tentative corrigée entre-temps (quiz avec reprise).
                    boolean capped = a.isRegrade()
                            || failures >= maxNoVerdictFailures
                            && (noVerdict || !Boolean.TRUE.equals(a.getQuiz().getAllowRetry()));
                    if (capped) {
                        a.setStatus(REVIEW);
                        attemptRepository.save(a);
                        // Raison du journal : une relance revient à revoir quel que soit le compte.
                        return a.isRegrade() ? REVIEW + ":relance" : REVIEW;
                    }
                    attemptRepository.delete(a);
                    return "deleted";
                })
                .orElse(null));
        if (outcome == null) {
            log.info("Tentative {} plus en pending : déjà corrigée ou supprimée, rien à abandonner",
                    attemptId);
            return;
        }
        boolean kept = outcome.startsWith(REVIEW);
        if (kept && outcome.equals(REVIEW)) {
            log.warn("Tentative {} gardée à revoir : plafond de {} échecs sans verdict atteint",
                    attemptId, maxNoVerdictFailures);
        } else if (kept) {
            log.warn("Tentative {} gardée à revoir : relance de l'enseignant en échec", attemptId);
        } else {
            log.info("Tentative {} supprimée après l'échec de sa correction", attemptId);
        }
        if (who != null) {
            realtimePublisher.quizAttemptFailed(who[0], who[1], attemptId, kept ? REVIEW : null);
        }
    }

    /**
     * Échecs SANS VERDICT de l'auteur sur ce quiz, celui-ci compris s'il en est un (il est alors
     * enregistré). Appelée dans la transaction qui verrouille la tentative : un seul pending existe
     * par (quiz, étudiant), donc deux échecs du même étudiant ne se croisent pas ici.
     */
    private int noVerdictFailuresAfter(Attempt attempt, boolean noVerdict) {
        GradingFailure.Key key = new GradingFailure.Key(attempt.getQuiz().getId(), attempt.getUser().getId());
        GradingFailure failure = gradingFailureRepository.findById(key).orElse(null);
        if (!noVerdict) {
            return failure == null ? 0 : failure.getNoVerdictCount();
        }
        if (failure == null) {
            failure = new GradingFailure();
            failure.setQuizId(attempt.getQuiz().getId());
            failure.setUserId(attempt.getUser().getId());
            failure.setNoVerdictCount(0);
        }
        failure.setNoVerdictCount(failure.getNoVerdictCount() + 1);
        failure.setLastFailureAt(LocalDateTime.now());
        gradingFailureRepository.save(failure);
        return failure.getNoVerdictCount();
    }

    /**
     * Tentatives « à revoir » d'un quiz (#116, S4), pour l'enseignant : leur correction a échoué
     * et failGrading les a gardées (relance, ou plafond atteint). Autorisation par rôle assurée en amont par le
     * permission-service (gestionnaires du contenu du quiz).
     */
    @Transactional(readOnly = true)
    public List<ReviewAttemptDTO> getAttemptsToReview(Integer quizId) {
        return attemptRepository.findByQuiz_IdAndStatusOrderBySubmittedAtAscIdAsc(quizId, REVIEW).stream()
                .map(a -> new ReviewAttemptDTO(
                        a.getId(),
                        a.getAttemptNo(),
                        a.getUser().getFirstName() + " " + a.getUser().getLastName(),
                        a.getSubmittedAt() == null ? null : a.getSubmittedAt().toInstant(ZoneOffset.UTC),
                        gradingFailureRepository.findById(
                                        new GradingFailure.Key(quizId, a.getUser().getId()))
                                .map(GradingFailure::getNoVerdictCount).orElse(0)))
                .toList();
    }

    /**
     * L'enseignant RELANCE la correction d'une tentative « à revoir » (#116, S4) : elle repasse en
     * {@code "pending"} et repart en correction après commit, comme une soumission. Si elle échoue
     * encore, quelle que soit la cause, elle revient à revoir grâce à son marqueur de relance
     * ({@link Attempt#isRegrade()}, cf. {@link #failGrading}) — pas grâce au plafond : sur un quiz
     * avec reprise, une autre tentative corrigée entre-temps a pu remettre le compte à zéro ; si
     * elle aboutit, l'étudiant reçoit son résultat ({@code quiz:attempt-graded}).
     *
     * <p>404 si la tentative n'appartient pas à ce quiz (la règle d'autorisation ne porte que sur
     * le quiz) ; 409 si elle n'est pas à revoir, ou si l'étudiant a déjà une correction en cours
     * sur ce quiz (index {@code uq_attempt_pending}).
     */
    public void regradeAttempt(Integer quizId, Integer attemptId) {
        TransactionTemplate writeTx = new TransactionTemplate(transactionManager);
        writeTx.executeWithoutResult(status -> {
            Attempt attempt = attemptRepository.findByIdForUpdate(attemptId)
                    .filter(a -> a.getQuiz().getId().equals(quizId))
                    .orElseThrow(AttemptNotFoundException::new);
            if (!REVIEW.equals(attempt.getStatus())) {
                throw new AttemptNotReviewableException();
            }
            attempt.setStatus("pending");
            attempt.setRegrade(true);
            try {
                attemptRepository.saveAndFlush(attempt);
            } catch (DataIntegrityViolationException e) {
                throw new AttemptNotReviewableException();
            }
            Quiz quiz = attempt.getQuiz();
            auditLogService.record("QUIZ_REGRADE", "QUIZ", quizId,
                    "Correction relancée : tentative " + attempt.getAttemptNo() + " de "
                            + attempt.getUser().getFirstName() + " " + attempt.getUser().getLastName()
                            + " au quiz « " + quiz.getTitle() + " »",
                    AuditContext.ofChildOfCourse(quiz.getCourse()));
            eventPublisher.publishEvent(new AttemptSubmittedEvent(attempt.getId(), needsSandbox(quiz)));
        });
    }

    /**
     * (tx lecture) Reconstruit le contexte de correction depuis la tentative PERSISTÉE : le code de
     * chaque question vient de sa {@link Submission}. {@code null} si la tentative n'existe plus.
     */
    private GradingContext loadGradingContext(Integer attemptId) {
        Attempt attempt = attemptRepository.findById(attemptId).orElse(null);
        // Plus en "pending" : une autre passe l'a déjà corrigée (cf. finalizeAttempt).
        if (attempt == null || !"pending".equals(attempt.getStatus())) return null;
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
            // Harnais-code pour TOUS les langages, côté execution-service : conteneur runner de
            // notation pour les compilés (harnais booléen, deux programmes sous deux UID,
            // verdict au nonce — #116), mode exec (programmes RPC à nonce) pour les
            // interprétés/SQL/vues.
            List<ExecutionClient.Harness> inputs = harnesses.stream()
                    .map(tc -> new ExecutionClient.Harness(tc.getName(), tc.getHarnessCode(), weightOf(tc)))
                    .toList();
            tasks.add(new CodeVerificationTask(question.getId(), language, code, testCaseIds, inputs,
                    question.getExecTimeoutMs(), question.getStartCode()));
        }
        return tasks;
    }

    /**
     * Exécute SYNCHRONEMENT (mais HORS transaction) les harnais de chaque question Code et renvoie
     * les verdicts par question ({@code questionId → (testCaseId → réussi)}). Lève
     * {@link CodeVerificationUnavailableException} dès qu'une question ne peut pas être évaluée
     * (service injoignable, réponse incohérente), ou sa sous-classe
     * {@link CodeVerificationNoVerdictException} quand le conteneur a tourné sans rendre de verdict :
     * la tentative pending est alors supprimée, ou gardée « à revoir » (cf. la gestion des échecs
     * de correction et son plafond).
     */
    private Map<Integer, Map<Integer, Boolean>> runCodeVerification(List<CodeVerificationTask> tasks) {
        Map<Integer, Map<Integer, Boolean>> verdictsByQuestion = new HashMap<>();
        for (CodeVerificationTask task : tasks) {
            List<Boolean> verdicts =
                    executionClient.evaluate(task.language(), task.code(), task.harnesses(), task.timeoutMs(),
                            task.startCode());
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
     *
     * <p>{@code false} si la tentative n'est plus {@code "pending"} : une autre passe (reprise au
     * démarrage) l'a déjà finalisée ; rien n'est écrit.
     */
    private boolean finalizeAttempt(Integer attemptId, Map<Integer, Map<Integer, Boolean>> codeVerdicts) {
        Attempt attempt = attemptRepository.findById(attemptId)
                .orElseThrow(AttemptNotFoundException::new);
        if (!"pending".equals(attempt.getStatus())) {
            return false;
        }
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
        attempt.setRegrade(false);
        attemptRepository.save(attempt);
        // Correction ABOUTIE : les échecs sans verdict passés de l'étudiant sur ce quiz ne
        // comptent plus (#116, S4) — le plafond vise une série d'échecs, pas un cumul à vie.
        gradingFailureRepository.deleteById(
                new GradingFailure.Key(attempt.getQuiz().getId(), attempt.getUser().getId()));
        return true;
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
                // Une tentative « à revoir » (#116, S4) en fait partie : elle consomme la tentative
                // unique, et l'étudiant doit le voir — sans note, puisqu'aucun verdict n'existe.
                // Pendant une relance de l'enseignant, elle reste « à revoir » pour l'étudiant :
                // l'exclure lui rendait un formulaire vierge, et sa soumission recevait un 409.
                .filter(a -> "done".equals(a.getStatus()) || awaitsTeacher(a))
                .map(a -> {
                    QuizResultDTO r = computeAttemptResult(a);
                    boolean review = awaitsTeacher(a);
                    return new AttemptSummaryDTO(
                            a.getId(),
                            a.getAttemptNo(),
                            review ? null : r.getEarned(),
                            r.getMax(),
                            a.getSubmittedAt() == null ? null : a.getSubmittedAt().toInstant(ZoneOffset.UTC),
                            review ? REVIEW : a.getStatus());
                })
                .toList();
    }

    /**
     * La tentative attend-elle l'enseignant ? À revoir, ou en cours de relance (elle redevient à
     * revoir si la relance échoue, cf. {@link #failGrading}). Une tentative relancée n'est jamais
     * {@code "done"} : finalizeAttempt retire le marqueur en la corrigeant.
     */
    private static boolean awaitsTeacher(Attempt attempt) {
        return REVIEW.equals(attempt.getStatus()) || attempt.isRegrade();
    }

    /**
     * Statut d'UNE tentative de l'utilisateur sur CE quiz : {@code "pending"}, {@code "done"} ou
     * {@code "review"} — une relance en cours vaut {@code "review"}, comme dans l'historique
     * ({@link #getMyAttempts}) : son verdict n'est pas celui que l'étudiant attend d'un envoi.
     * 404 ({@link AttemptNotFoundException}) pour une tentative absente ou supprimée (correction
     * échouée), d'un autre étudiant ou d'un autre quiz, sans distinction : pas de fuite
     * d'existence. Sert au client qui attend une correction et a pu manquer le verdict WebSocket
     * — {@link #getAttemptResult} répond 404 aussi bien pendant la correction qu'après une
     * suppression, et ne permet pas de les distinguer.
     */
    @Transactional(readOnly = true)
    public AttemptStatusDTO getAttemptStatus(Integer quizId, Integer attemptId, String userEmail) {
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);
        Attempt attempt = attemptRepository.findByIdAndUser_Id(attemptId, user.getId())
                .filter(a -> a.getQuiz().getId().equals(quizId))
                .orElseThrow(AttemptNotFoundException::new);
        return new AttemptStatusDTO(awaitsTeacher(attempt) ? REVIEW : attempt.getStatus());
    }

    /**
     * Résultat corrigé d'UNE tentative donnée (révision), restreint à son propriétaire, et
     * seulement une fois CORRIGÉE ({@code "done"}) : le résultat porte le corrigé des questions
     * sans code (bonnes options, ordre attendu). Lu pendant la correction ({@code "pending"}), il
     * le livrait avant la note ; et si la correction échouait ensuite, la tentative était supprimée
     * et l'étudiant resoumettait avec les bonnes réponses (#116). Une tentative « à revoir » n'a
     * pas de corrigé non plus. 404 dans les deux cas, comme une tentative inconnue.
     */
    @Transactional(readOnly = true)
    public QuizResultDTO getAttemptResult(Integer attemptId, String userEmail) {
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);
        Attempt attempt = attemptRepository.findByIdAndUser_Id(attemptId, user.getId())
                .filter(a -> "done".equals(a.getStatus()))
                .orElseThrow(AttemptNotFoundException::new);
        return maskItemIds(computeAttemptResult(attempt));
    }

    /**
     * Ids PUBLICS → ids réels dans les réponses d'éléments déplaçables (ordre, placement). Un id
     * inconnu devient {@code null} (ordre) ou est ignoré (placement) : l'ordre est alors refusé
     * par {@link #requireValidOrderings}, comme toute liste qui n'est pas une permutation.
     */
    private Map<Integer, SubmittedAnswerDTO> unmaskItemIds(Map<Integer, SubmittedAnswerDTO> byQuestion) {
        Map<Integer, SubmittedAnswerDTO> unmasked = new HashMap<>();
        byQuestion.forEach((questionId, answer) -> {
            SubmittedAnswerDTO copy = SubmittedAnswerDTO.builder()
                    .questionId(answer.getQuestionId())
                    .answerIds(answer.getAnswerIds())
                    .code(answer.getCode())
                    .build();
            if (answer.getOrderedItemIds() != null) {
                copy.setOrderedItemIds(answer.getOrderedItemIds().stream()
                        .map(itemObfuscator::unmask).collect(Collectors.toCollection(ArrayList::new)));
            }
            if (answer.getPlacement() != null) {
                Map<Integer, String> placement = new HashMap<>();
                answer.getPlacement().forEach((publicId, group) -> {
                    Integer realId = itemObfuscator.unmask(publicId);
                    if (realId != null) placement.put(realId, group);
                });
                copy.setPlacement(placement);
            }
            unmasked.put(questionId, copy);
        });
        return unmasked;
    }

    /** Ids réels → ids PUBLICS dans un résultat renvoyé à l'étudiant (même espace que la passation). */
    private QuizResultDTO maskItemIds(QuizResultDTO result) {
        for (QuestionResultDTO question : result.getQuestions()) {
            question.setCorrectOrder(maskAll(question.getCorrectOrder()));
            question.setSubmittedOrder(maskAll(question.getSubmittedOrder()));
            if (question.getMatching() != null) {
                question.getMatching().forEach(m -> m.setItemId(itemObfuscator.mask(m.getItemId())));
            }
        }
        return result;
    }

    private List<Integer> maskAll(List<Integer> ids) {
        if (ids == null) return null;
        return ids.stream().map(itemObfuscator::mask).collect(Collectors.toCollection(ArrayList::new));
    }

    /**
     * Agrégat de réussite aux quiz d'un COURS (pour l'analyse MCP) : re-note chaque tentative
     * via {@link #computeAttemptResult} et moyenne les % par tentative. Les questions de CODE
     * sont EXCLUES (core ne les note pas : elles compteraient 0 et fausseraient la moyenne ;
     * leur réussite est mesurée séparément via les tests). Aucune note n'est stockée.
     */
    @Transactional(readOnly = true)
    public CourseQuizStatsDTO getCourseQuizStats(Integer courseId) {
        // Deux requêtes, quel que soit le nombre de tentatives : tentatives + soumissions, puis
        // verdicts de tests de ces soumissions (le résultat sert seulement à remplir leurs
        // collections, déjà en mémoire, avant la correction ci-dessous).
        List<Attempt> attempts = attemptRepository.findWithSubmissionsByCourseId(courseId);
        submissionRepository.findWithTestCaseResultsByCourseId(courseId);
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
            case "coding" -> gradeCoding(question, answer, codeVerdicts);
            default -> CodeGrading.pending(question);
        };
    }

    /**
     * Note une question Code à partir de ses verdicts ({@code testCaseId → réussi}). Sans verdict
     * (question Code jamais évaluée) → « en cours » (tests = null).
     */
    private QuestionResultDTO gradeCoding(
            Question question, SubmittedAnswerDTO answer, Map<Integer, Boolean> codeVerdicts) {
        List<TestCase> harnesses = orderedTestCases(question);
        String submittedCode = answer != null ? answer.getCode() : null;
        return CodeGrading.build(
                question, harnesses, codeVerdicts == null ? Map.of() : codeVerdicts, submittedCode);
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
        // Dédoublonné : la requête vient du client. Sans ça, [1, 1] comptait deux bonnes réponses
        // pour une seule cochée et donnait la note maximale au choix multiple.
        List<Integer> selectedIds = answer != null && answer.getAnswerIds() != null
                ? new ArrayList<>(new LinkedHashSet<>(answer.getAnswerIds())) : List.of();
        Set<Integer> correctSet = new HashSet<>(correctIds);

        double total = question.getTotalScore() != null ? question.getTotalScore() : 0.0;
        double earned;
        if (correctIds.isEmpty()) {
            // Question mal configurée (antérieure à la validation, cf. requireCorrectOption) :
            // aucun point à gagner, plutôt que le score plein pour une réponse vide.
            earned = 0.0;
        } else if ("multiple_choice".equals(slug)) {
            long good = selectedIds.stream().filter(correctSet::contains).count();
            long bad = selectedIds.stream().filter(id -> !correctSet.contains(id)).count();
            // correctIds n'est jamais vide ici : le cas est traité juste au-dessus.
            double ratio = (double) (good - bad) / correctIds.size();
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

    /**
     * Une remise en ordre soumise doit être une PERMUTATION des éléments de la question : chacun
     * exactement une fois, aucun en trop ni d'une autre question. L'interface n'envoie que ça ; une
     * autre liste vient d'une requête fabriquée. Liste absente ou vide = question non répondue (0).
     */
    private void requireValidOrderings(Quiz quiz, Map<Integer, SubmittedAnswerDTO> byQuestion) {
        int index = 0;
        for (Question q : sortedQuestions(quiz)) {
            index++;
            String slug = slugFor(q);
            SubmittedAnswerDTO answer = byQuestion.get(q.getId());
            if (!"ordering".equals(slug) || answer == null) continue;
            if (!isPermutationOrEmpty(q, answer.getOrderedItemIds())) {
                throw new InvalidQuizException("Question " + index
                        + " : l'ordre soumis doit contenir chaque élément exactement une fois.");
            }
        }
    }

    /**
     * Taille maximale d'un code soumis, en caractères — miroir de la borne d'execution-service
     * ({@code EvaluateRequest.code}, {@code @Size(max = 100_000)}).
     */
    static final int MAX_CODE_CHARS = 100_000;

    /**
     * Un code soumis plus long que ce qu'execution-service accepte est refusé ICI (400, tentative
     * non consommée). Accepté puis transmis, il recevait un 400 du service d'exécution : la
     * tentative était supprimée sans compter comme un échec sans verdict, un nouvel essai à
     * volonté sur une question à tentative unique (#116). Toutes les questions sont bornées,
     * pas seulement celles à harnais : la colonne qui stocke la réponse n'a pas de limite.
     */
    private void requireBoundedCode(Quiz quiz, Map<Integer, SubmittedAnswerDTO> byQuestion) {
        int index = 0;
        for (Question q : sortedQuestions(quiz)) {
            index++;
            SubmittedAnswerDTO answer = byQuestion.get(q.getId());
            if (answer != null && answer.getCode() != null && answer.getCode().length() > MAX_CODE_CHARS) {
                throw new InvalidQuizException("Question " + index + " : le code soumis dépasse "
                        + MAX_CODE_CHARS + " caractères.");
            }
        }
    }

    /** Vrai si `submitted` est absent/vide, ou contient chaque élément de la question une seule fois. */
    private static boolean isPermutationOrEmpty(Question question, List<Integer> submitted) {
        if (submitted == null || submitted.isEmpty()) return true;
        List<DragItem> items = question.getDragItems() == null ? List.of() : question.getDragItems();
        Set<Integer> expected = items.stream().map(DragItem::getId).collect(Collectors.toSet());
        return submitted.size() == expected.size()
                && !submitted.contains(null)
                && new HashSet<>(submitted).equals(expected);
    }

    /** Éléments d'une Remise en ordre dans l'ordre attendu (correctOrder absent = 0, tri stable). */
    private static List<DragItem> inExpectedOrder(List<DragItem> items) {
        return items.stream()
                .sorted(Comparator.comparing(d -> d.getCorrectOrder() == null ? 0 : d.getCorrectOrder()))
                .toList();
    }

    private QuestionResultDTO gradeOrdering(Question question, SubmittedAnswerDTO answer) {
        List<DragItem> items = question.getDragItems() == null ? List.of() : question.getDragItems();
        List<Integer> correctOrder = inExpectedOrder(items).stream().map(DragItem::getId).toList();
        List<Integer> submittedOrder = answer != null && answer.getOrderedItemIds() != null
                ? answer.getOrderedItemIds() : List.of();

        int correctCount = 0;
        // Ordre mal formé (donnée antérieure à la validation, cf. requireValidOrderings) : 0.
        int limit = isPermutationOrEmpty(question, submittedOrder) ? submittedOrder.size() : 0;
        for (int i = 0; i < limit && i < correctOrder.size(); i++) {
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
            requireExecutableSizes(qd, index);
            q.setStartCode(qd.getStartCode());
            q.setExecTimeoutMs(normalizeExecTimeout(qd.getExecTimeoutMs()));
            q.setOrderIndex(qd.getOrderIndex() != null ? qd.getOrderIndex() : index);
            q.setTotalScore(qd.getTotalScore() != null ? qd.getTotalScore() : 0.0);
            q.setQType(resolveQType(qd));
            q.setLanguage(resolveLanguage(qd));
            q.setAnswers(buildAnswers(qd.getAnswers(), q));
            requireCorrectOption(q, index);
            requireValidOrderingItems(q, qd.getDragItems(), index);
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

    /**
     * Temps limite d'exécution par question : null (défaut du sandbox) si absent ou non positif,
     * sinon borné au plafond du runner (RunnerExec.MAX_RUN_TIMEOUT_MS = 60 s). Une valeur
     * aberrante envoyée à l'API ne doit jamais atteindre la base (mur de conteneur négatif,
     * budgets de lecture faussés).
     *
     * <p>Arrondi à la seconde SUPÉRIEURE : le superviseur du runner travaille en secondes
     * entières ({@code timeout_ms // 1000}). 1 500 ms y devenaient 1 s alors que core et
     * execution-service budgétaient 1,5 s ; la valeur stockée est maintenant celle qui
     * s'applique vraiment.
     */
    private static Integer normalizeExecTimeout(Integer ms) {
        if (ms == null || ms <= 0) return null;
        int capped = Math.min(ms, 60_000);
        return (capped + 999) / 1000 * 1000;
    }

    /** Bornes d'execution-service ({@code EvaluateRequest}, {@code TestCaseInput}), en miroir. */
    static final int MAX_TEST_CASES = 100;
    static final int MAX_HARNESS_CHARS = 50_000;
    /**
     * Nom d'un harnais : la colonne {@code Test_Case.name} (VARCHAR(128)) est plus courte que la
     * borne d'execution-service (500). Au-delà, la base refusait avec un 409 générique.
     */
    static final int MAX_TEST_CASE_NAME_CHARS = 128;

    /**
     * Refus À L'ÉCRITURE de ce qu'execution-service refuserait à chaque correction : code de
     * départ (transmis depuis #22), nombre de harnais, taille d'un harnais ou de son nom. Accepté
     * ici, chaque correction recevait un 400 : la tentative était supprimée avec un « correction
     * échouée » générique, et plus personne ne pouvait être noté sur ce quiz, sans que
     * l'enseignant le sache. {@code index} part de 0.
     */
    private static void requireExecutableSizes(QuestionDTO qd, int index) {
        String where = "Question " + (index + 1) + " : ";
        if (qd.getStartCode() != null && qd.getStartCode().length() > MAX_CODE_CHARS) {
            throw new InvalidQuizException(where + "le code de départ dépasse " + MAX_CODE_CHARS
                    + " caractères.");
        }
        List<TestCaseDTO> cases = qd.getTestCases() == null ? List.of() : qd.getTestCases();
        if (cases.size() > MAX_TEST_CASES) {
            throw new InvalidQuizException(where + "au plus " + MAX_TEST_CASES + " harnais.");
        }
        for (TestCaseDTO td : cases) {
            if (td.getHarnessCode() != null && td.getHarnessCode().length() > MAX_HARNESS_CHARS) {
                throw new InvalidQuizException(where + "un harnais dépasse " + MAX_HARNESS_CHARS
                        + " caractères.");
            }
            if (td.getName() != null && td.getName().length() > MAX_TEST_CASE_NAME_CHARS) {
                throw new InvalidQuizException(where + "un nom de harnais dépasse "
                        + MAX_TEST_CASE_NAME_CHARS + " caractères.");
            }
        }
    }

    /** Applique les champs d'un QuestionDTO sur une question (existante ou neuve), en place. */
    private void applyQuestionFields(Question q, QuestionDTO qd, int index, Quiz quiz) {
        q.setQuiz(quiz);
        q.setPrompt(qd.getPrompt());
        requireExecutableSizes(qd, index);
        q.setStartCode(qd.getStartCode());
        q.setExecTimeoutMs(normalizeExecTimeout(qd.getExecTimeoutMs()));
        q.setOrderIndex(qd.getOrderIndex() != null ? qd.getOrderIndex() : index);
        q.setTotalScore(qd.getTotalScore() != null ? qd.getTotalScore() : 0.0);
        q.setQType(resolveQType(qd));
        q.setLanguage(resolveLanguage(qd));
        applyAnswers(q, qd.getAnswers());
        requireCorrectOption(q, index);
        requireValidOrderingItems(q, qd.getDragItems(), index);
        applyDragItems(q, qd.getDragItems());
        applyTestCases(q, qd.getTestCases());
    }

    /**
     * Une question à choix (Vrai/Faux, choix unique, choix multiple) doit avoir au moins une bonne
     * réponse. Sans elle, la notation n'a pas de sens : l'ensemble vide attendu donnait le score
     * plein à une réponse vide. L'éditeur le bloque déjà ; ici on protège l'API elle-même.
     */
    private static void requireCorrectOption(Question q, int index) {
        String slug = slugFor(q);
        boolean choice = "true_false".equals(slug) || "single_choice".equals(slug)
                || "multiple_choice".equals(slug);
        if (!choice) return;
        boolean hasCorrect = q.getAnswers() != null
                && q.getAnswers().stream().anyMatch(a -> Boolean.TRUE.equals(a.getIsCorrect()));
        if (!hasCorrect) {
            throw new InvalidQuizException(
                    "Question " + (index + 1) + " : au moins une bonne réponse doit être cochée.");
        }
    }

    /**
     * Une Remise en ordre a au moins {@value #MIN_ORDERING_ITEMS} éléments : avec deux, le seul
     * ordre de départ différent de la solution la révélerait (#211). Et chaque élément doit avoir
     * une position ({@code correctOrder}) présente et distincte : sinon plusieurs ordres seraient
     * équivalents et le correcteur n'en accepterait qu'un, choisi par l'ordre d'insertion en base.
     * L'éditeur bloque déjà les deux ; ici on protège l'API elle-même. On lit les valeurs ENVOYÉES
     * (avant le repli « absent = 0 » des entités). Les associations n'utilisent pas
     * {@code correctOrder} (0 partout) : non concernées.
     */
    private static void requireValidOrderingItems(Question q, List<DragItemDTO> items, int index) {
        if (!"ordering".equals(slugFor(q))) return;
        if (items == null || items.size() < MIN_ORDERING_ITEMS) {
            throw new InvalidQuizException("Question " + (index + 1)
                    + " : une remise en ordre doit avoir au moins " + MIN_ORDERING_ITEMS + " éléments.");
        }
        Set<Integer> seen = new HashSet<>();
        for (DragItemDTO item : items) {
            if (item.getCorrectOrder() == null || !seen.add(item.getCorrectOrder())) {
                throw new InvalidQuizException("Question " + (index + 1)
                        + " : chaque élément doit avoir une position distincte dans l'ordre attendu.");
            }
        }
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
                .execTimeoutMs(question.getExecTimeoutMs())
                .answers(question.getAnswers() == null ? List.of()
                        : question.getAnswers().stream()
                        .map(a -> toAnswerDTO(a, includeCorrection)).toList())
                .dragItems(toDragItemDTOs(question, includeCorrection))
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

    private static String slugFor(Question question) {
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

    /**
     * Éléments déplaçables d'une question. ÉDITEUR : ids réels, ordre de la base. PASSATION : ids
     * PUBLICS (masqués), et ni l'ordre reçu ni le tri des ids ne révèlent {@code correctOrder} ou
     * les groupes (#28). Une Association est mélangée à chaque envoi. Une Remise en ordre arrive
     * dans un ordre de départ FIXE (#211) : le même pour tous les étudiants et à chaque chargement,
     * jamais l'ordre attendu ; le client, qui ne le connaît pas, garde l'ordre reçu.
     */
    private List<DragItemDTO> toDragItemDTOs(Question question, boolean includeCorrection) {
        if (question.getDragItems() == null) return List.of();
        List<DragItem> items;
        if (includeCorrection) {
            // Vue enseignant : une remise en ordre arrive dans son ordre attendu, que l'éditeur
            // affiche tel quel. L'ordre de la base ne suit pas correctOrder : les éléments gardent
            // leur id d'un enregistrement à l'autre (#229).
            items = "ordering".equals(slugFor(question))
                    ? inExpectedOrder(question.getDragItems())
                    : question.getDragItems();
        } else if ("ordering".equals(slugFor(question))) {
            items = itemObfuscator.fixedOrderExcept(question.getId(), question.getDragItems(),
                    inExpectedOrder(question.getDragItems()), DragItem::getId);
        } else {
            items = itemObfuscator.shuffled(question.getDragItems());
        }
        return items.stream().map(d -> toDragItemDTO(d, includeCorrection)).toList();
    }

    private DragItemDTO toDragItemDTO(DragItem dragItem, boolean includeCorrection) {
        return DragItemDTO.builder()
                .id(includeCorrection ? dragItem.getId() : itemObfuscator.mask(dragItem.getId()))
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
