package com.moodit.core_service.controller;

// DTO
import com.moodit.core_service.dto.*;

// Service
import com.moodit.core_service.service.CourseService;
import com.moodit.core_service.service.ProgramService;

import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import java.util.List;

@RestController
@RequestMapping("/programs") // /api/programs
@RequiredArgsConstructor
public class ProgramController {

  private final ProgramService programService;

  // region GET
  // Retourne programs
  @GetMapping
  public ResponseEntity<List<ProgramDTO>> findAll() {
    return ResponseEntity.ok(programService.findAll());
  }

  // Retourne un program
  @GetMapping("/{programId}")
  public ResponseEntity<ProgramDTO> findById(@PathVariable Integer programId) {
    return ResponseEntity.ok(programService.findById(programId));
  }

  // Retourne courses d'un programme
  @GetMapping("/{programId}/courses")
  public ResponseEntity<ProgramCoursesDTO> getCoursesByProgram(@PathVariable Integer programId) {
    return ResponseEntity.ok(programService.getCoursesByProgram(programId));
  }

  // Retourne un cours d'un programme
  @GetMapping("/{programId}/courses/{courseId}")
  public ResponseEntity<CourseDTO> getCourseByProgram(
      @PathVariable Integer programId, @PathVariable Integer courseId) {
    return ResponseEntity.ok(programService.getCourseByProgram(programId, courseId));
  }

  // endregion

  // region POST
  // Ajouter un cours dans des programmes
  @PostMapping("/courses")
  public ResponseEntity<CourseDTO> addCourseToPrograms(
      @RequestBody CourseCreateInProgramsDTO courseCreateDTO) {
    return ResponseEntity.ok(programService.addCourseToPrograms(courseCreateDTO));
  }

  // Ajouter un usager dans un programme
  @PostMapping("/users")
  public ResponseEntity<Void> addUserToPrograms(
      @RequestBody UserCreateInProgramsDTO userCreateDTO) {
    programService.addUserToPrograms(userCreateDTO);
    return ResponseEntity.status(201).build();
  }

  // endregion

  // region PATCH
  @PatchMapping("/{programId}")
  public ResponseEntity<ProgramDTO> updateProgram(
      @PathVariable Integer programId, @RequestBody ProgramUpdateDTO programUpdateDTO) {
    return ResponseEntity.ok(programService.updateProgram(programId, programUpdateDTO));
  }

  // endregion

  // Quitter un programme
  @DeleteMapping("/{programId}/users/{userId}")
  public ResponseEntity<Void> removeUserFromProgram(
      @PathVariable Integer programId, @PathVariable Integer userId) {
    programService.removeUserFromProgram(programId, userId);
    return ResponseEntity.noContent().build();
  }
}
