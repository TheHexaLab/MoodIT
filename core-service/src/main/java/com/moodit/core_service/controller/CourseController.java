package com.moodit.core_service.controller;

// Model
import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.CourseUpdateDTO;
import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.dto.QuizDTO;
import com.moodit.core_service.dto.QuizDetailDTO;

// Service
import com.moodit.core_service.dto.UserCreateInCoursesDTO;
import com.moodit.core_service.service.CourseService;

import com.moodit.core_service.service.ForumService;
import com.moodit.core_service.service.QuizService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/courses")
@RequiredArgsConstructor
public class CourseController {

  private final CourseService courseService;
  private final ForumService forumService;
  private final QuizService quizService;

  @GetMapping("/{courseId}")
  public ResponseEntity<?> findCourse(@PathVariable Integer courseId) {
    return ResponseEntity.ok(courseService.findById(courseId));
  }

  @GetMapping("/{courseId}/forums")
  public ResponseEntity<List<ForumDTO>> getForumsByCourse(
      @PathVariable Integer courseId, @RequestParam(required = false) Integer typeId) {

    return ResponseEntity.ok(courseService.getForumsByCourseAndType(courseId, typeId));
  }

  @GetMapping("/{courseId}/forums/{forumId}")
  public ResponseEntity<ForumDTO> getForumByCourseAndId(
      @PathVariable Integer courseId, @PathVariable Integer forumId) {

    return ResponseEntity.ok(courseService.getForumByIdInCourse(courseId, forumId));
  }

  @PostMapping("/forums")
  public ResponseEntity<ForumDTO> addForumToCourse(@RequestBody ForumDTO request) {

    return ResponseEntity.ok(courseService.addForumToCourse(request));
  }

  @PostMapping("/users")
  public ResponseEntity<List<CourseDTO>> addUserToCourses(
      @RequestBody UserCreateInCoursesDTO request) {

    return ResponseEntity.ok(courseService.syncUserCourses(request));
  }

  @PatchMapping("/{courseId}")
  public ResponseEntity<CourseDTO> updateCourse(
      @PathVariable Integer courseId, @RequestBody CourseUpdateDTO request) {

    return ResponseEntity.ok(courseService.updateCourse(courseId, request));
  }

  @DeleteMapping("/{courseId}")
  public ResponseEntity<Void> deleteCourse(@PathVariable Integer courseId) {
    courseService.deleteCourse(courseId);
    return ResponseEntity.noContent().build();
  }

  @DeleteMapping("/{courseId}/users/{userId}")
  public ResponseEntity<Void> removeUserFromCourse(
      @PathVariable Integer courseId, @PathVariable Integer userId) {
    courseService.removeUserFromCourse(courseId, userId);
    return ResponseEntity.noContent().build();
  }

  // ── Quiz d'un cours ──────────────────────────────────────────────────────────

  /** Quiz d'un cours (méta seule). `published=true` → seulement les publiés (vue étudiant). */
  @GetMapping("/{courseId}/quizzes")
  public ResponseEntity<List<QuizDTO>> getQuizzesByCourse(
      @PathVariable Integer courseId, @RequestParam(defaultValue = "false") boolean published) {
    return ResponseEntity.ok(quizService.listQuizzes(courseId, published));
  }

  /** Crée un quiz complet (méta + questions) dans le cours. */
  @PostMapping("/{courseId}/quizzes")
  public ResponseEntity<QuizDetailDTO> createQuiz(
      @PathVariable Integer courseId, @RequestBody QuizDetailDTO request) {
    return ResponseEntity.ok(quizService.createQuiz(courseId, request));
  }

  /** Réordonne les quiz du cours (ids dans le nouvel ordre). */
  @PatchMapping("/{courseId}/quizzes/reorder")
  public ResponseEntity<Void> reorderQuizzes(
      @PathVariable Integer courseId, @RequestBody List<Integer> quizIds) {
    quizService.reorderQuizzes(courseId, quizIds);
    return ResponseEntity.noContent().build();
  }
}
