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

  @GetMapping("/{programId}/users")
  public ResponseEntity<List<UserDTO>> getUsersByProgram(@PathVariable Integer programId) {
    return ResponseEntity.ok(programService.getUsersByProgram(programId));
  }

  /**
   * Candidats paginés à l'attribution d'un rôle DANS ce programme (membres n'ayant pas `roleId`),
   * filtrés côté BD par `search`. Alimente le sélecteur d'ajout du popup « Gérer les rôles ».
   */
  @GetMapping("/{programId}/role-candidates")
  public ResponseEntity<List<UserDTO>> getProgramRoleCandidates(
      @PathVariable Integer programId,
      @RequestParam("roleId") Integer roleId,
      @RequestParam(name = "search", required = false) String search,
      @RequestParam(name = "page", defaultValue = "0") int page,
      @RequestParam(name = "size", defaultValue = "10") int size) {
    return ResponseEntity.ok(
        programService.getProgramRoleCandidates(programId, roleId, search, page, size));
  }

  // endregion

  // region POST
  /**
   * Ajouter un cours dans des programmes. Réservé (403 sinon) aux admins globaux / gardiens, ou aux
   * Administrateurs/Enseignants de TOUS les programmes visés. `X-User-Email` injecté par la gateway.
   */
  @PostMapping("/courses")
  public ResponseEntity<CourseDTO> addCourseToPrograms(
      @RequestBody CourseCreateInProgramsDTO courseCreateDTO,
      @RequestHeader("X-User-Email") String email) {
    return ResponseEntity.ok(programService.addCourseToPrograms(courseCreateDTO, email));
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

  // Supprimer un programme (admin) — cascade + diffusion WS program:deleted à chaque abonné.
  @DeleteMapping("/{programId}")
  public ResponseEntity<Void> deleteProgram(@PathVariable Integer programId) {
    programService.deleteProgram(programId);
    return ResponseEntity.noContent().build();
  }
}
