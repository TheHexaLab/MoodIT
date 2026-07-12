package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.ForumNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.*;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.EnrollmentRepository;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.CourseDto;
import com.moodit.core_service.realtime.dto.ItemChangeDto;
import com.moodit.core_service.realtime.dto.ItemDto;
import java.util.Objects;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.LocalDateTime;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class CourseService {

  private final CourseRepository courseRepository;
  private final ForumRepository forumRepository;
  private final ForumService forumService;
  private final ProgramService programService;
  private final UserRepository userRepository;
  private final EnrollmentRepository enrollmentRepository;
  private final RealtimeEventPublisher realtimePublisher;
  private final AuditLogService auditLogService;


  /** Exécute l'action après le commit (ou tout de suite hors transaction). */
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

  public CourseDTO toCourseDTO(Course course) {
    CourseDTO dto = new CourseDTO();

    dto.setId(course.getId());
    dto.setTitle(course.getTitle());
    dto.setCode(course.getCode());

    return dto;
  }

  public CourseProgramsDTO toCourseProgramsDTO(Course course) {
    CourseProgramsDTO dto = new CourseProgramsDTO();

    dto.setId(course.getId());
    dto.setTitle(course.getTitle());
    dto.setCode(course.getCode());
    dto.setPrograms(course.getPrograms().stream().map(programService::toProgramDTO).toList());

    return dto;
  }

  public CourseForumsDTO toCourseForumsDTO(Course course) {
    CourseForumsDTO dto = new CourseForumsDTO();

    dto.setId(course.getId());
    dto.setTitle(course.getTitle());
    dto.setCode(course.getCode());
    dto.setForums(course.getForums().stream().map(forumService::toForumDTO).toList());
    // Quiz PUBLIÉS du cours (méta seule), triés par `position`. Les brouillons ne sont
    // pas listés dans la sidebar ; l'enseignant les gère via l'éditeur (GET /quizzes).
    dto.setQuizzes(
        course.getQuizzes() == null
            ? List.of()
            : course.getQuizzes().stream()
                .filter(q -> Boolean.TRUE.equals(q.getIsPublished()))
                .sorted(
                    Comparator.comparing(
                        Quiz::getPosition, Comparator.nullsLast(Comparator.naturalOrder())))
                .map(this::toQuizDTO)
                .toList());

    return dto;
  }

  /** Méta d'un quiz pour les vues de liste (section Quiz d'un cours), sans les questions. */
  public QuizDTO toQuizDTO(Quiz quiz) {
    QuizDTO dto = new QuizDTO();
    dto.setId(quiz.getId());
    dto.setTitle(quiz.getTitle());
    dto.setPosition(quiz.getPosition());
    dto.setIsPublished(quiz.getIsPublished());
    dto.setIsDaily(quiz.getIsDaily());
    dto.setAllowRetry(quiz.getAllowRetry());
    dto.setQuestionCount(quiz.getQuestions() == null ? 0 : quiz.getQuestions().size());
    dto.setCreatedAt(quiz.getCreatedAt());
    return dto;
  }

  public CourseDTO findById(Integer id) {
    Course course = courseRepository.findById(id).orElseThrow(CourseNotFoundException::new);

    return toCourseDTO(course);
  }

  public List<ForumDTO> getForumsByCourseId(Integer courseId) {
    Course course = courseRepository.findById(courseId).orElseThrow(CourseNotFoundException::new);

    return course.getForums().stream().map(forum -> forumService.findById(forum.getId())).toList();
  }

  public List<ForumDTO> getForumsByCourseAndType(Integer courseId, Integer typeId) {

    Course course = courseRepository.findById(courseId).orElseThrow(CourseNotFoundException::new);

    return course.getForums().stream()
        .filter(f -> typeId == null || f.getFType().getId().equals(typeId))
        .map(forumService::toForumDTO)
        .toList();
  }

  public ForumDTO getForumByIdInCourse(Integer courseId, Integer forumId) {

    Course course = courseRepository.findById(courseId).orElseThrow(CourseNotFoundException::new);

    Forum forum =
        course.getForums().stream()
            .filter(f -> f.getId().equals(forumId))
            .findFirst()
            .orElseThrow(
                () ->
                    new RuntimeException(
                        "Forum not found with id " + forumId + " in course " + courseId));
    return forumService.findById(forum.getId());
  }

  public ForumDTO addForumToCourse(ForumDTO dto) {

    Course course =
        courseRepository.findById(dto.getCourseId()).orElseThrow(CourseNotFoundException::new);

    Forum forum = new Forum();

    forum.setTitle(dto.getTitle());
    forum.setCourse(course);

    FType fType = new FType();
    fType.setId(dto.getFTypeId());

    forum.setPosition(dto.getPosition());

    forum.setFType(fType);

    Forum saved = forumRepository.save(forum);

    return forumService.toForumDTO(saved);
  }

  @Transactional
  public CourseDTO updateCourse(Integer courseId, CourseUpdateDTO dto) {
    Course course = courseRepository.findById(courseId).orElseThrow(CourseNotFoundException::new);

    if (dto.getTitle() != null) {
      course.setTitle(dto.getTitle());
    }
    if (dto.getCode() != null) {
      course.setCode(dto.getCode());
    }
    if (dto.getProgramIds() != null) {
      // Liste MUTABLE (pas .toList() immuable) : l'entité est managée (@Transactional),
      // Hibernate synchronise la collection au flush et doit pouvoir la muter.
      List<Program> programs =
          dto.getProgramIds().stream()
              .map(programService::findProgramById)
              .collect(Collectors.toList());
      course.setPrograms(programs);
    }

    Course saved = courseRepository.save(course);

    auditLogService.record(
        "COURSE_UPDATE",
        "COURSE",
        courseId,
        "Cours « " + saved.getTitle() + " » (" + saved.getCode() + ") mis à jour",
        AuditContext.ofCourse(saved));

    // ── Temps réel : le cours modifié est répercuté LIVE dans chaque programme (room program:<id>).
    // Version simple : on émet courseEdited aux programmes ACTUELS (un changement d'appartenance
    // via programIds n'émet pas de created/deleted sur le delta — cas admin rare, à raffiner). ──
    long cId = saved.getId();
    String code = saved.getCode();
    String title = saved.getTitle();
    List<Integer> programIds =
        saved.getPrograms() == null ? List.of() : saved.getPrograms().stream().map(Program::getId).toList();
    afterCommit(() ->
        programIds.forEach(pid -> realtimePublisher.courseEdited(pid, CourseDto.of(cId, code, title))));

    return toCourseDTO(saved);
  }

  @Transactional
  public void deleteCourse(Integer courseId) {
    Course course = courseRepository.findById(courseId).orElseThrow(CourseNotFoundException::new);

    // Capturé AVANT delete (collection lazy vidée ensuite) ; émis après commit.
    long cId = course.getId();
    String title = course.getTitle();
    List<Integer> programIds =
        course.getPrograms() == null ? List.of() : course.getPrograms().stream().map(Program::getId).toList();
    // Capturé AVANT delete : la collection lazy de programmes sera vidée par la suppression.
    String programsDetails = AuditContext.ofCourse(course);

    courseRepository.delete(course);

    auditLogService.record(
        "COURSE_DELETE",
        "COURSE",
        courseId,
        "Cours « " + title + " » (#" + courseId + ") supprimé",
        programsDetails);

    afterCommit(() -> programIds.forEach(pid -> realtimePublisher.courseDeleted(pid, cId)));
  }

  /** F_Type.id des sections : 'text' = canal 'Discussion' (1), 'forum' = 'Thread' (2). */
  private static final int F_TYPE_DISCUSSION = 1;
  private static final int F_TYPE_THREAD = 2;

  /**
   * Persiste une modification de section (canal 'text' / forum) et la diffuse en temps réel.
   * Agit sur des Forum du bon f_type. Pour un `create`, renvoie le changement AVEC l'id RÉEL
   * (le front réconcilie son affichage optimiste ; l'écho WS est alors idempotent par id).
   * Les quiz ont leurs propres endpoints (createQuiz/reorderQuizzes…) — pas concernés ici.
   */
  @Transactional
  public ItemChangeDto changeSection(Integer courseId, String sectionType, ItemChangeDto change) {
    Course course = courseRepository.findById(courseId).orElseThrow(CourseNotFoundException::new);
    int fTypeId = "text".equals(sectionType) ? F_TYPE_DISCUSSION : F_TYPE_THREAD;
    String courseDetails = AuditContext.ofChildOfCourse(course);

    ItemChangeDto emitted;
    switch (change.type()) {
      case "create" -> {
        Forum forum = new Forum();
        forum.setTitle(change.item().name());
        forum.setCourse(course);
        FType ft = new FType();
        ft.setId(fTypeId);
        forum.setFType(ft);
        forum.setPosition(nextPosition(course, fTypeId));
        Forum saved = forumRepository.saveAndFlush(forum); // flush → id réel
        // Cohérence de la collection managée (orphanRemoval) : le forum créé y figure.
        if (course.getForums() != null) course.getForums().add(saved);
        auditLogService.record(
            "FORUM_CREATE",
            "FORUM",
            saved.getId(),
            "Forum « " + saved.getTitle() + " » créé dans le cours #" + courseId,
            courseDetails);
        emitted = ItemChangeDto.create(new ItemDto(String.valueOf(saved.getId()), saved.getTitle()));
      }
      case "rename" -> {
        Forum forum = forumInCourse(course, change.id());
        forum.setTitle(change.name());
        forumRepository.save(forum);
        auditLogService.record(
            "FORUM_RENAME",
            "FORUM",
            forum.getId(),
            "Forum « " + change.name() + " » renommé",
            courseDetails);
        emitted = ItemChangeDto.rename(change.id(), change.name());
      }
      case "delete" -> {
        Forum forum = forumInCourse(course, change.id());
        // orphanRemoval=true sur Course.forums : on RETIRE de la collection managée (au lieu
        // de forumRepository.delete, qui serait annulé par la cascade tant que le forum y est).
        course.getForums().remove(forum);
        auditLogService.record(
            "FORUM_DELETE",
            "FORUM",
            forum.getId(),
            "Forum #" + forum.getId() + " supprimé",
            courseDetails);
        emitted = ItemChangeDto.delete(change.id());
      }
      case "reorder" -> {
        int pos = 0;
        for (String id : change.orderedIds()) {
          Forum forum = forumInCourse(course, id);
          forum.setPosition(pos++);
          forumRepository.save(forum);
        }
        emitted = ItemChangeDto.reorder(change.orderedIds());
      }
      default -> throw new IllegalArgumentException("Type de changement inconnu : " + change.type());
    }

    // ── Temps réel : la modification est répercutée dans chaque programme du cours. ──
    long cId = course.getId();
    List<Integer> programIds =
        course.getPrograms() == null ? List.of() : course.getPrograms().stream().map(Program::getId).toList();
    ItemChangeDto ws = emitted;
    afterCommit(() ->
        programIds.forEach(pid -> realtimePublisher.sectionChanged(pid, cId, sectionType, ws)));

    return emitted;
  }

  /** Position en fin de section : max(position) du f_type dans le cours + 1 (0 si vide). */
  private int nextPosition(Course course, int fTypeId) {
    if (course.getForums() == null) return 0;
    return course.getForums().stream()
        .filter(f -> f.getFType() != null && Objects.equals(f.getFType().getId(), fTypeId))
        .map(Forum::getPosition)
        .filter(Objects::nonNull)
        .max(Integer::compareTo)
        .map(p -> p + 1)
        .orElse(0);
  }

  /** Retrouve un Forum du cours par son id (chaîne côté front → Integer). */
  private Forum forumInCourse(Course course, String idStr) {
    Integer id;
    try {
      id = Integer.valueOf(idStr);
    } catch (NumberFormatException e) {
      // id temporaire non réconcilié (ex. crypto.randomUUID d'un create non persisté) : 404 propre.
      throw new ForumNotFoundException();
    }
    return (course.getForums() == null ? List.<Forum>of() : course.getForums()).stream()
        .filter(f -> f.getId().equals(id))
        .findFirst()
        .orElseThrow(ForumNotFoundException::new);
  }

  @Transactional
  public List<CourseDTO> syncUserCourses(UserCreateInCoursesDTO dto) {

    User user = userRepository.findById(dto.getId()).orElseThrow(UserNotFoundException::new);

    List<Enrollment> currentEnrollments = user.getEnrollments();

    List<Integer> courseIds = dto.getCourseIds() == null ? List.of() : dto.getCourseIds();
    Set<Integer> requestedCourseIds = new HashSet<>(courseIds);
    Integer programId = dto.getProgramId();

    // Prédicat de désinscription (réutilisé pour la capture d'audit ET le removeIf).
    java.util.function.Predicate<Enrollment> toRemove =
        enrollment -> {
          Course course = enrollment.getCourse();
          boolean inProgram =
              programId == null
                  || (course.getPrograms() != null
                      && course.getPrograms().stream().anyMatch(p -> p.getId().equals(programId)));
          return inProgram && !requestedCourseIds.contains(course.getId());
        };

    // Capturé AVANT le removeIf : les cours dont l'inscription va être retirée (pour l'audit).
    List<Course> coursesToRemove =
        currentEnrollments.stream().filter(toRemove).map(Enrollment::getCourse).toList();

    // 1. REMOVE : seulement les inscriptions aux cours DU PROGRAMME concerné qui ne sont
    //    plus sélectionnés (déselection = désinscription, liste vide comprise).
    //    programId null → portée globale (rétrocompat).
    currentEnrollments.removeIf(toRemove);

    // 2. Existing after cleanup
    Set<Integer> remainingCourseIds =
        currentEnrollments.stream().map(e -> e.getCourse().getId()).collect(Collectors.toSet());

    // 3. ADD missing enrollments
    List<Course> coursesToAdd =
        courseIds.stream()
            .distinct()
            .filter(id -> !remainingCourseIds.contains(id))
            .map(id -> courseRepository.findById(id).orElseThrow(CourseNotFoundException::new))
            .toList();

    for (Course course : coursesToAdd) {
      Enrollment enrollment = new Enrollment();
      enrollment.setUser(user);
      enrollment.setCourse(course);
      enrollment.setEnrolledAt(LocalDateTime.now());

      user.getEnrollments().add(enrollment);
    }

    userRepository.save(user);

    // ── Audit des changements d'inscription (dans la transaction). ──
    String userRef = user.getUsername() != null ? user.getUsername() : "#" + user.getId();
    for (Course course : coursesToAdd) {
      auditLogService.record(
          "ENROLLMENT_JOIN",
          "ENROLLMENT",
          course.getId(),
          "Inscription au cours « " + course.getTitle() + " » (" + course.getCode() + ")",
          AuditContext.ofChildOfCourse(course)
              + " · Utilisateur : "
              + userRef
              + enrollProgramSuffix(course, programId));
    }
    for (Course course : coursesToRemove) {
      auditLogService.record(
          "ENROLLMENT_LEAVE",
          "ENROLLMENT",
          course.getId(),
          "Désinscription du cours « " + course.getTitle() + " » (" + course.getCode() + ")",
          AuditContext.ofChildOfCourse(course)
              + " · Utilisateur : "
              + userRef
              + enrollProgramSuffix(course, programId));
    }

    return user.getEnrollments().stream()
        .map(Enrollment::getCourse)
        .distinct()
        .map(this::toCourseDTO)
        .toList();
  }

  public void removeUserFromCourse(Integer courseId, Integer userId) {
    User user = userRepository.findById(userId).orElseThrow(UserNotFoundException::new);

    Course course = courseRepository.findById(courseId).orElse(null);
    String courseLabel =
        course != null
            ? "« " + course.getTitle() + " » (" + course.getCode() + ")"
            : "#" + courseId;

    user.getEnrollments().removeIf(e -> e.getCourse().getId().equals(courseId));
    userRepository.save(user);

    String userRef = user.getUsername() != null ? user.getUsername() : "#" + user.getId();
    String enrollDetails =
        (course != null ? AuditContext.ofChildOfCourse(course) : "Cours : #" + courseId)
            + " · Utilisateur : "
            + userRef;
    auditLogService.record(
        "ENROLLMENT_LEAVE",
        "ENROLLMENT",
        courseId,
        "Désinscription du cours " + courseLabel,
        enrollDetails);
  }

  /**
   * Suffixe d'audit « · Programme : <nom> » pour l'inscription passée par ce programme. Le nom est
   * résolu depuis les programmes DÉJÀ chargés du cours (aucune requête) ; repli sur « #id » sinon.
   */
  private String enrollProgramSuffix(Course course, Integer programId) {
    if (programId == null) {
      return "";
    }
    String name =
        course.getPrograms() == null
            ? null
            : course.getPrograms().stream()
                .filter(p -> programId.equals(p.getId()))
                .map(Program::getName)
                .findFirst()
                .orElse(null);
    return name != null ? " · Programme : " + name : " · Programme #" + programId;
  }
}
