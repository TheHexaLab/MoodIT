package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.*;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.EnrollmentRepository;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.UserRepository;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

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

  public CourseDTO updateCourse(Integer courseId, CourseUpdateDTO dto) {
    Course course = courseRepository.findById(courseId).orElseThrow(CourseNotFoundException::new);

    if (dto.getTitle() != null) {
      course.setTitle(dto.getTitle());
    }
    if (dto.getCode() != null) {
      course.setCode(dto.getCode());
    }
    if (dto.getProgramIds() != null) {
      List<Program> programs =
          dto.getProgramIds().stream().map(programService::findProgramById).toList();
      course.setPrograms(programs);
    }

    Course saved = courseRepository.save(course);
    return toCourseDTO(saved);
  }

  public void deleteCourse(Integer courseId) {
    Course course = courseRepository.findById(courseId).orElseThrow(CourseNotFoundException::new);

    courseRepository.delete(course);
  }

  @Transactional
  public List<CourseDTO> syncUserCourses(UserCreateInCoursesDTO dto) {

    User user = userRepository.findById(dto.getId()).orElseThrow(UserNotFoundException::new);

    List<Enrollment> currentEnrollments = user.getEnrollments();

    List<Integer> courseIds = dto.getCourseIds() == null ? List.of() : dto.getCourseIds();
    Set<Integer> requestedCourseIds = new HashSet<>(courseIds);
    Integer programId = dto.getProgramId();

    // 1. REMOVE : seulement les inscriptions aux cours DU PROGRAMME concerné qui ne sont
    //    plus sélectionnés (déselection = désinscription, liste vide comprise).
    //    programId null → portée globale (rétrocompat).
    currentEnrollments.removeIf(
        enrollment -> {
          Course course = enrollment.getCourse();
          boolean inProgram =
              programId == null
                  || (course.getPrograms() != null
                      && course.getPrograms().stream().anyMatch(p -> p.getId().equals(programId)));
          return inProgram && !requestedCourseIds.contains(course.getId());
        });

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

    return user.getEnrollments().stream()
        .map(Enrollment::getCourse)
        .distinct()
        .map(this::toCourseDTO)
        .toList();
  }
}
