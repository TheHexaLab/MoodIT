package com.moodit.core_service.service;

// Model
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Enrollment;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.model.User;
import java.time.LocalDateTime;

// DTO
import com.moodit.core_service.dto.*;

// Exception
import com.moodit.core_service.exception.ProgramNotFoundException;
import com.moodit.core_service.exception.CourseNotFoundException;

import com.moodit.core_service.model.RoleNames;
import com.moodit.core_service.model.UserProgramRole;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.EnrollmentRepository;
import com.moodit.core_service.repository.ProgramRepository;
import com.moodit.core_service.repository.UserProgramRoleRepository;
import com.moodit.core_service.repository.UserRepository;
import java.util.Map;
import org.springframework.data.domain.PageRequest;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.CourseDto;
import com.moodit.core_service.realtime.dto.ProgramDto;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class ProgramService {

  private final ProgramRepository programRepository;
  private final CourseRepository courseRepository;
  private final UserRepository userRepository;
  private final UserProgramRoleRepository userProgramRoleRepository;
  private final EnrollmentRepository enrollmentRepository;
  private final RealtimeEventPublisher realtimePublisher;
  private final AuditLogService auditLogService;
  //private final UserService userService;

  /** DTO temps réel d'un programme (scope user:<id>). */
  private ProgramDto toRealtimeProgramDto(Program p) {
    return new ProgramDto(p.getId(), p.getName(), p.getCode(), p.getCohort(), p.getColor());
  }

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

  // region Transformations d'Entités (entité BD -> DTO)
  public ProgramDTO toProgramDTO(Program program) {
    return ProgramDTO.builder()
        .id(program.getId())
        .name(program.getName())
        .code(program.getCode())
        .cohort(program.getCohort())
        .color(program.getColor())
        .build();
  }

  private ProgramCoursesDTO toProgramCoursesDTO(Program program) {
    ProgramCoursesDTO dto = new ProgramCoursesDTO();

    dto.setId(program.getId());
    dto.setName(program.getName());
    dto.setCode(program.getCode());
    dto.setCohort(program.getCohort());
    dto.setColor(program.getColor());
    dto.setCourses(program.getCourses().stream().map(this::toCourseDTO).toList());
    return dto;
  }

  private CourseDTO toCourseDTO(Course course) {
    CourseDTO dto = new CourseDTO();

    dto.setId(course.getId());
    dto.setTitle(course.getTitle());
    dto.setCode(course.getCode());

    return dto;
  }

  // endregion

  // region GET
  public List<ProgramDTO> findAll() {
    return programRepository.findAll().stream().map(this::toProgramDTO).toList();
  }

  public ProgramDTO findById(Integer programId) {
    if (programId == null) {
      throw new IllegalArgumentException();
    }

    Program program =
        programRepository.findById(programId).orElseThrow(ProgramNotFoundException::new);

    return toProgramDTO(program);
  }

  public ProgramCoursesDTO getCoursesByProgram(Integer programId) {
    if (programId == null) {
      throw new IllegalArgumentException();
    }

    Program program =
        programRepository.findById(programId).orElseThrow(ProgramNotFoundException::new);

    return toProgramCoursesDTO(program);
  }

  public CourseDTO getCourseByProgram(Integer programId, Integer courseId) {
    if (programId == null || courseId == null) {
      throw new IllegalArgumentException();
    }

    Program program =
        programRepository.findById(programId).orElseThrow(() -> new ProgramNotFoundException());
    return program.getCourses().stream()
        .filter(c -> c.getId().equals(courseId))
        .findFirst()
        .map(this::toCourseDTO)
        .orElseThrow(() -> new CourseNotFoundException());
  }

  public List<UserDTO> getUsersByProgram(Integer programId) {
    // Rôles PAR PROGRAMME (User_Program_Role) — PAS les rôles globaux (User_Role).
    Map<Integer, List<Integer>> rolesByUser =
        userProgramRoleRepository.findByProgramId(programId).stream()
            .collect(
                Collectors.groupingBy(
                    UserProgramRole::getUserId,
                    Collectors.mapping(UserProgramRole::getRoleId, Collectors.toList())));

    return userRepository.findDistinctByPrograms_Id(programId).stream()
        .map(u -> toUserDTO(u, rolesByUser.getOrDefault(u.getId(), List.of())))
        .toList();
  }

  /**
   * Candidats paginés à l'attribution d'un rôle DANS un programme : MEMBRES du programme
   * (User_Program) n'ayant pas `roleId`, filtrés côté BD par `search`. Alimente le sélecteur
   * d'ajout du popup « Gérer les rôles » (infinite scroll + recherche). Chaque candidat porte
   * ses rôles ACTUELS dans ce programme (pour l'affichage correct des sections après ajout).
   */
  public List<UserDTO> getProgramRoleCandidates(
      Integer programId, Integer roleId, String search, int page, int size) {
    String q = search == null ? "" : search.trim().toLowerCase();
    int safeSize = size <= 0 ? 10 : Math.min(size, 50);
    int safePage = Math.max(page, 0);

    Map<Integer, List<Integer>> rolesByUser =
        userProgramRoleRepository.findByProgramId(programId).stream()
            .collect(
                Collectors.groupingBy(
                    UserProgramRole::getUserId,
                    Collectors.mapping(UserProgramRole::getRoleId, Collectors.toList())));

    return userRepository
        .findProgramRoleCandidates(programId, roleId, q, PageRequest.of(safePage, safeSize))
        .stream()
        .map(u -> toUserDTO(u, rolesByUser.getOrDefault(u.getId(), List.of())))
        .toList();
  }

  private UserDTO toUserDTO(User user, List<Integer> programRoleIds) {
    UserDTO dto = new UserDTO();

    dto.setId(user.getId());
    dto.setUsername(user.getUsername());
    dto.setFirstName(user.getFirstName());
    dto.setLastName(user.getLastName());
    dto.setEmail(user.getEmail());
    dto.setSettings(user.getSettings());
    dto.setAvatarColor(user.getAvatarColor());
    dto.setCreatedAt(user.getCreatedAt());

    // Rôles de l'utilisateur DANS ce programme (peut être vide).
    dto.setRoles(programRoleIds);

    return  dto;
  }

  // endregion

  /** Rôles GLOBAUX (User_Role) qui autorisent la gestion de N'IMPORTE quel programme. */
  private static final Set<String> GLOBAL_ADMIN_ROLES = Set.of(RoleNames.ADMIN, RoleNames.GUARDIAN);

  /** L'utilisateur porte-t-il un rôle GLOBAL Administrateur/Gardien (accès plateforme) ? */
  private boolean isGlobalAdmin(User user) {
    return user.getRoles() != null
        && user.getRoles().stream().anyMatch(r -> GLOBAL_ADMIN_ROLES.contains(r.getName()));
  }

  /**
   * Programmes d'un établissement dans lesquels l'utilisateur peut AJOUTER un cours : ceux où il est
   * Administrateur/Enseignant (User_Program_Role). Un admin global / gardien voit TOUS les
   * programmes de l'établissement. Alimente le popup « Créer un cours ».
   */
  @Transactional(readOnly = true)
  public List<ProgramDTO> getManageableProgramsInEstablishment(Integer establishmentId, String userEmail) {
    User user = userRepository.findByEmail(userEmail).orElseThrow(UserNotFoundException::new);
    List<Program> programs =
        isGlobalAdmin(user)
            ? programRepository.findByEstablishment_Id(establishmentId)
            : programRepository.findManageableInEstablishment(user.getId(), establishmentId);
    return programs.stream().map(this::toProgramDTO).toList();
  }

  // region POST
  @Transactional
  public CourseDTO addCourseToPrograms(CourseCreateInProgramsDTO courseCreateDTO) {
    if (courseCreateDTO == null
            || courseCreateDTO.getProgramIds() == null
            || courseCreateDTO.getProgramIds().isEmpty() ) {
      throw new IllegalArgumentException();
    }

    // Autorisation PAR RÔLE déléguée au permission-service (règle POST /programs/courses,
    // predicat canCreateCourse) : Administrateur/Gardien GLOBAL, ou Administrateur/Enseignant
    // dans CHACUN des programmes visés — 403 rendu par le gateway sinon.

    List<Program> programs =
        courseCreateDTO.getProgramIds().stream()
            .distinct()
            .map(id -> programRepository.findById(id).orElseThrow(ProgramNotFoundException::new))
            .toList();

    Course course =
        Course.builder()
            .code(courseCreateDTO.getCode())
            .title(courseCreateDTO.getTitle())
            .forums(List.of())
            .programs(List.of())
            .build();

    courseRepository.save(course);

    programs.forEach(p -> p.getCourses().add(course));
    programRepository.saveAll(programs);

    // ── Temps réel : le cours apparaît LIVE dans chaque programme concerné (room program:<id>). ──
    long courseId = course.getId();
    String code = course.getCode();
    String title = course.getTitle();
    List<Integer> programIds = programs.stream().map(Program::getId).toList();

    String coursePrograms = AuditContext.ofPrograms(programs); // "Programmes : … · Établissements : …"

    auditLogService.record(
        "COURSE_CREATE",
        "COURSE",
        course.getId(),
        "Cours « " + title + " » (" + code + ") créé",
        coursePrograms);

    // ── Auto-inscription du CRÉATEUR au cours qu'il vient de créer (idempotent) + journalisation.
    //    Le lien bidirectionnel n'a été posé que côté Program (p.getCourses().add) : on construit
    //    donc le contexte à partir de `programs` (course.getPrograms() est encore vide ici). ──
    String creatorEmail = auditLogService.currentActor();
    if (creatorEmail != null) {
      userRepository
          .findByEmail(creatorEmail)
          .ifPresent(
              creator -> {
                if (enrollmentRepository
                    .findByUserIdAndCourseId(creator.getId(), course.getId())
                    .isEmpty()) {
                  Enrollment enrollment = new Enrollment();
                  enrollment.setUser(creator);
                  enrollment.setCourse(course);
                  enrollment.setEnrolledAt(LocalDateTime.now());
                  enrollmentRepository.save(enrollment);

                  String creatorRef =
                      creator.getUsername() != null ? creator.getUsername() : "#" + creator.getId();
                  auditLogService.record(
                      "ENROLLMENT_JOIN",
                      "ENROLLMENT",
                      course.getId(),
                      "Inscription au cours « " + title + " » (" + code + ") à sa création",
                      "Cours : " + title + " (" + code + ")"
                          + (coursePrograms != null ? " · " + coursePrograms : "")
                          + " · Utilisateur : " + creatorRef);
                }
              });
    }

    afterCommit(() ->
        programIds.forEach(pid -> realtimePublisher.courseCreated(pid, CourseDto.of(courseId, code, title))));

    return toCourseDTO(course);
  }

  @Transactional
  public void addUserToPrograms(UserCreateInProgramsDTO userCreateDTO) {
    if (userCreateDTO == null || userCreateDTO.getProgramIds() == null) {
      throw new IllegalArgumentException("programIds cannot be null");
    }

    User user =
        userRepository.findById(userCreateDTO.getId()).orElseThrow(UserNotFoundException::new);

    Set<Integer> requestedIds = new HashSet<>(userCreateDTO.getProgramIds());
    Integer establishmentId = userCreateDTO.getEstablishmentId();

    // SYNCHRO scopée à l'établissement : on retire les programmes DE CET ÉTABLISSEMENT que
    // l'utilisateur a déselectionnés (= désabonnement). Les programmes des autres
    // établissements ne sont jamais touchés. establishmentId null → pas de retrait (ajout seul).
    List<Integer> removedIds = new ArrayList<>();
    if (establishmentId != null) {
      user.getPrograms()
          .removeIf(
              p -> {
                boolean remove =
                    p.getEstablishment() != null
                        && establishmentId.equals(p.getEstablishment().getId())
                        && !requestedIds.contains(p.getId());
                if (remove) removedIds.add(p.getId());
                return remove;
              });
    }

    // Ajoute les programmes demandés pas encore suivis (évite les doublons).
    Set<Integer> existingProgramIds =
        user.getPrograms().stream().map(Program::getId).collect(Collectors.toSet());

    List<Program> programsToAdd =
        userCreateDTO.getProgramIds().stream()
            .distinct()
            .filter(id -> !existingProgramIds.contains(id))
            .map(id -> programRepository.findById(id).orElseThrow(ProgramNotFoundException::new))
            .toList();

    user.getPrograms().addAll(programsToAdd);

    userRepository.save(user);

    List<Integer> auditProgramIds =
        userCreateDTO.getProgramIds().stream().distinct().toList();
    Integer auditProgramId = auditProgramIds.size() == 1 ? auditProgramIds.get(0) : null;
    // Noms des programmes réellement AJOUTÉS (repli sur les ids si la liste est vide).
    String auditProgramNames =
        programsToAdd.isEmpty()
            ? auditProgramIds.toString()
            : programsToAdd.stream().map(Program::getName).collect(Collectors.joining(", "));
    auditLogService.record(
        "PROGRAM_MEMBER_ADD",
        "PROGRAM",
        auditProgramId,
        "Utilisateur "
            + (user.getUsername() != null ? user.getUsername() : "#" + user.getId())
            + " ajouté au(x) programme(s) : "
            + auditProgramNames,
        "Programme(s) : " + auditProgramNames);

    // ── Temps réel (room user:<id>) : la liste des programmes suivis se met à jour LIVE. ──
    long userId = user.getId();
    List<ProgramDto> addedDtos = programsToAdd.stream().map(this::toRealtimeProgramDto).toList();
    afterCommit(() -> {
      removedIds.forEach(pid -> realtimePublisher.subscriptionRemoved(userId, pid));
      addedDtos.forEach(dto -> realtimePublisher.subscriptionAdded(userId, dto));
    });
  }

  // endregion

  // region PATCH
  @Transactional
  public ProgramDTO updateProgram(Integer programId, ProgramUpdateDTO programUpdateDTO) {
    if (programId == null || programUpdateDTO == null) {
      throw new IllegalArgumentException("L'identifiant et le DTO ne peuvent pas être nuls");
    }

    Program program =
        programRepository.findById(programId).orElseThrow(() -> new ProgramNotFoundException());
    if (programUpdateDTO.getName() != null) {
      program.setName(programUpdateDTO.getName());
    }
    if (programUpdateDTO.getCode() != null) {
      program.setCode(programUpdateDTO.getCode());
    }
    if (programUpdateDTO.getCohort() != null) {
      program.setCohort(programUpdateDTO.getCohort());
    }
    if (programUpdateDTO.getColor() != null) {
      program.setColor(programUpdateDTO.getColor());
    }

    programRepository.save(program);

    auditLogService.record(
        "PROGRAM_UPDATE",
        "PROGRAM",
        programId,
        "Programme « " + program.getName() + " » mis à jour",
        program.getEstablishment() != null
            ? "Établissement : " + program.getEstablishment().getName()
            : null);

    // ── Temps réel : chaque ABONNÉ (room user:<id>) voit le programme mis à jour LIVE. ──
    ProgramDto dto = toRealtimeProgramDto(program);
    List<Integer> subscriberIds =
        userRepository.findDistinctByPrograms_Id(programId).stream().map(User::getId).toList();
    afterCommit(() -> subscriberIds.forEach(uid -> realtimePublisher.programUpdated(uid, dto)));

    // ── Temps réel (GLOBAL) : le catalogue de l'établissement change (nom/code/couleur…) → le
    // popup « Ajouter un programme » met à jour la liste des programmes LIVE. ──
    if (program.getEstablishment() != null) {
      publishEstablishmentCatalog(program.getEstablishment().getId());
    }

    return toProgramDTO(program);
  }

  // endregion

  /**
   * Diffuse (GLOBAL, after-commit) la LISTE À JOUR des programmes d'un établissement pour le popup
   * « Ajouter un programme ». Appelé après un ajout / une modification / une suppression de
   * programme. La requête auto-flush les changements en attente avant de lire.
   */
  public void publishEstablishmentCatalog(Integer establishmentId) {
    if (establishmentId == null) {
      return;
    }
    long estId = establishmentId;
    List<ProgramDto> programs =
        programRepository.findByEstablishment_Id(establishmentId).stream()
            .map(this::toRealtimeProgramDto)
            .toList();
    afterCommit(() -> realtimePublisher.establishmentUpdated(estId, programs));
  }

  public Program findProgramById(Integer programId) {
    return programRepository.findById(programId).orElseThrow(ProgramNotFoundException::new);
  }

  // Quitter un programme
  @Transactional
  public void removeUserFromProgram(Integer programId, Integer userId) {
    User user = userRepository.findById(userId).orElseThrow(UserNotFoundException::new);

    // Nom du programme capturé pour l'audit (le programme lui-même n'est pas supprimé).
    String programName =
        programRepository.findById(programId).map(Program::getName).orElse("#" + programId);

    // 1. Quitte le programme (User_Program). saveAndFlush : les nettoyages suivants doivent VOIR le
    //    retrait (le calcul « cours encore accessibles via un autre programme » en dépend).
    user.getPrograms().removeIf(p -> p.getId().equals(programId));
    userRepository.saveAndFlush(user);

    // 2. Retire ses rôles DANS ce programme (User_Program_Role).
    userProgramRoleRepository.deleteByProgramIdAndUserId(programId, userId);

    // 3. Retire ses inscriptions (Enrollment) aux cours de ce programme devenues inaccessibles
    //    (un cours partagé avec un autre programme encore rejoint reste accessible → conservé).
    enrollmentRepository.deleteForUserLeavingProgram(userId, programId);

    auditLogService.record(
        "PROGRAM_MEMBER_REMOVE",
        "PROGRAM",
        programId,
        "Utilisateur "
            + (user.getUsername() != null ? user.getUsername() : "#" + userId)
            + " retiré du programme « "
            + programName
            + " »",
        "Programme : " + programName);

    // ── Temps réel : l'utilisateur qui quitte (room user:<id>) retire le programme de sa liste. ──
    long uId = user.getId();
    long pId = programId;
    afterCommit(() -> realtimePublisher.subscriptionRemoved(uId, pId));
  }

  // Supprimer un programme (admin) — le retire pour TOUS ses abonnés.
  @Transactional
  public void deleteProgram(Integer programId) {
    Program program =
        programRepository.findById(programId).orElseThrow(ProgramNotFoundException::new);

    // Établissement du programme capturé AVANT delete (pour l'écho catalogue).
    Integer establishmentId =
        program.getEstablishment() != null ? program.getEstablishment().getId() : null;

    // Nom capturé AVANT delete (pour le résumé d'audit).
    String programName = program.getName();
    String establishmentName =
        program.getEstablishment() != null ? program.getEstablishment().getName() : null;

    // Abonnés capturés AVANT delete (pour l'écho WS user:<id> ; collection lazy vidée ensuite).
    List<Integer> subscriberIds =
        userRepository.findDistinctByPrograms_Id(programId).stream().map(User::getId).toList();

    // Cours rattachés au programme, capturés AVANT le delete : on supprimera ensuite ceux devenus
    // orphelins (plus rattachés à aucun programme). Les cours PARTAGÉS avec un autre programme restent.
    List<Integer> courseIds =
        program.getCourses() == null
            ? List.of()
            : program.getCourses().stream().map(Course::getId).toList();

    // ON DELETE CASCADE en base : User_Program, program_course (seul le lien est retiré),
    // User_Program_Role. flush() : le retrait des liens program_course doit être VISIBLE avant
    // le calcul des cours orphelins ci-dessous.
    programRepository.delete(program);
    programRepository.flush();

    // Supprime les cours devenus orphelins (le ON DELETE CASCADE en base emporte forums, quiz,
    // inscriptions et réponses MCP du cours supprimé). Garde IN () vide → pas de requête.
    if (!courseIds.isEmpty()) {
      courseRepository.deleteOrphanedAmong(courseIds);
    }

    auditLogService.record(
        "PROGRAM_DELETE",
        "PROGRAM",
        programId,
        "Programme « " + programName + " » (#" + programId + ") supprimé",
        "Établissement : " + establishmentName);

    // ── Temps réel : chaque abonné (room user:<id>) retire le programme de sa liste. ──
    afterCommit(() -> subscriberIds.forEach(uid -> realtimePublisher.programDeleted(uid, programId)));

    // ── Temps réel (GLOBAL) : le catalogue de l'établissement change → le popup « Ajouter un
    // programme » met à jour la liste des programmes LIVE (la requête auto-flush le retrait). ──
    publishEstablishmentCatalog(establishmentId);
  }
}
