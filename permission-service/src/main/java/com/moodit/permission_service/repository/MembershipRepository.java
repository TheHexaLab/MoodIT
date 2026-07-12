// Verifs d'appartenance encapsulees dans un repository Spring Data : le SQL natif
// (sur le schema init.sql) reste confine ici, le reste du code n'appelle que des
// methodes typees. Reprend la logique de core DbRoomAuthorizer et l'enrichit de
// l'inscription directe au cours (Enrollment).
//
// Rattache a l'entite User par commodite Spring Data ; les requetes sont natives et
// ne dependent pas de ce mapping.

package com.moodit.permission_service.repository;

import com.moodit.permission_service.model.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface MembershipRepository extends JpaRepository<User, Integer> {

  // Abonne au programme (User_Program).
  @Query(
      value =
          "SELECT EXISTS(SELECT 1 FROM User_Program WHERE user_id = :userId AND program_id = :programId)",
      nativeQuery = true)
  boolean isSubscribedToProgram(@Param("userId") long userId, @Param("programId") long programId);

  // Le forum appartient a un cours d'un programme auquel l'utilisateur est abonne.
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM Forum f
            JOIN program_course pc ON pc.course_id = f.course_id
            JOIN User_Program up   ON up.program_id = pc.program_id
            WHERE f.id = :forumId AND up.user_id = :userId
          )
          """,
      nativeQuery = true)
  boolean canSeeForumViaProgram(@Param("userId") long userId, @Param("forumId") long forumId);

  // Le cours appartient a un programme auquel l'utilisateur est abonne (scope MCP).
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM program_course pc
            JOIN User_Program up ON up.program_id = pc.program_id
            WHERE pc.course_id = :courseId AND up.user_id = :userId
          )
          """,
      nativeQuery = true)
  boolean canSeeCourseViaProgram(@Param("userId") long userId, @Param("courseId") long courseId);

  // Le quiz appartient a un cours d'un programme auquel l'utilisateur est abonne
  // (routes REST /api/quizzes/{quizId} : lecture / soumission).
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM Quiz q
            JOIN program_course pc ON pc.course_id = q.course_id
            JOIN User_Program up   ON up.program_id = pc.program_id
            WHERE q.id = :quizId AND up.user_id = :userId
          )
          """,
      nativeQuery = true)
  boolean canSeeQuizViaProgram(@Param("userId") long userId, @Param("quizId") long quizId);

  // Le cours appartient-il (structurellement) au programme ? (table de jointure program_course)
  @Query(
      value =
          "SELECT EXISTS(SELECT 1 FROM program_course WHERE course_id = :courseId AND program_id = :programId)",
      nativeQuery = true)
  boolean isCourseInProgram(@Param("courseId") long courseId, @Param("programId") long programId);

  // L'utilisateur est-il inscrit a ce cours ? (inscription directe, table Enrollment)
  @Query(
      value =
          "SELECT EXISTS(SELECT 1 FROM Enrollment WHERE user_id = :userId AND course_id = :courseId)",
      nativeQuery = true)
  boolean isEnrolledInCourse(@Param("userId") long userId, @Param("courseId") long courseId);

  // L'utilisateur est-il le createur (auteur) de ce post ? (colonne Post.user_id)
  @Query(
      value =
          "SELECT EXISTS(SELECT 1 FROM Post WHERE id = :postId AND user_id = :userId)",
      nativeQuery = true)
  boolean isPostAuthor(@Param("userId") long userId, @Param("postId") long postId);

  // Le vote appartient-il a cet utilisateur ? (colonne Vote.user_id)
  @Query(
      value =
          "SELECT EXISTS(SELECT 1 FROM Vote WHERE id = :voteId AND user_id = :userId)",
      nativeQuery = true)
  boolean isVoteOwner(@Param("userId") long userId, @Param("voteId") long voteId);

  // L'utilisateur a-t-il le role (nomme) DANS ce programme ? (table User_Program_Role)
  // A distinguer du role GLOBAL (user_role) porte par l'entite User / hasRole.
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM User_Program_Role upr
            JOIN Role r ON r.id = upr.role_id
            WHERE upr.user_id = :userId AND upr.program_id = :programId AND r.name = :roleName
          )
          """,
      nativeQuery = true)
  boolean hasRoleInProgram(
      @Param("userId") long userId,
      @Param("programId") long programId,
      @Param("roleName") String roleName);

  // L'utilisateur a-t-il le role (nomme) dans AU MOINS UN programme (User_Program_Role), sans
  // cibler un programme precis ? Sert a gater GET /api/roles?scope=program (liste des roles
  // attribuables en programme) : etre gestionnaire d'un programme quelconque suffit.
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM User_Program_Role upr
            JOIN Role r ON r.id = upr.role_id
            WHERE upr.user_id = :userId AND r.name = :roleName
          )
          """,
      nativeQuery = true)
  boolean hasRoleInAnyProgram(@Param("userId") long userId, @Param("roleName") String roleName);

  // L'utilisateur a-t-il le role (nomme) SUR ce cours ? Combine role scope-programme
  // (User_Program_Role) et appartenance du cours au programme (program_course). Ex. avec
  // roleName = 'Enseignant' : "est-il prof du cours ?".
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM User_Program_Role upr
            JOIN Role r            ON r.id = upr.role_id
            JOIN program_course pc ON pc.program_id = upr.program_id
            WHERE upr.user_id = :userId AND pc.course_id = :courseId AND r.name = :roleName
          )
          """,
      nativeQuery = true)
  boolean hasRoleInCourse(
      @Param("userId") long userId,
      @Param("courseId") long courseId,
      @Param("roleName") String roleName);

  // L'utilisateur a-t-il le role (nomme) sur le COURS DU QUIZ ? Comme hasRoleInCourse, mais
  // l'id fourni est celui du QUIZ (routes /api/quizzes/{quizId} de gestion de contenu) : on
  // resout quiz -> cours via Quiz.course_id. Ex. avec roleName = 'Enseignant' : "est-il prof
  // du cours auquel appartient ce quiz ?".
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM User_Program_Role upr
            JOIN Role r            ON r.id = upr.role_id
            JOIN program_course pc ON pc.program_id = upr.program_id
            JOIN Quiz q            ON q.course_id = pc.course_id
            WHERE upr.user_id = :userId AND q.id = :quizId AND r.name = :roleName
          )
          """,
      nativeQuery = true)
  boolean hasRoleInQuizCourse(
      @Param("userId") long userId,
      @Param("quizId") long quizId,
      @Param("roleName") String roleName);

  // L'utilisateur a-t-il le role (nomme) sur le COURS DE CETTE ANALYSE MCP ? Comme
  // hasRoleInQuizCourse, mais l'id fourni est celui d'une ligne MCP_Response (route REST
  // GET /mcp/analyses/{id}) : on resout analyse -> cours via MCP_Response.course_id. Ex.
  // avec roleName = 'Enseignant' : "est-il prof du cours auquel se rattache cette analyse ?".
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM User_Program_Role upr
            JOIN Role r            ON r.id = upr.role_id
            JOIN program_course pc ON pc.program_id = upr.program_id
            JOIN MCP_Response m    ON m.course_id = pc.course_id
            WHERE upr.user_id = :userId AND m.id = :analysisId AND r.name = :roleName
          )
          """,
      nativeQuery = true)
  boolean hasRoleInAnalysisCourse(
      @Param("userId") long userId,
      @Param("analysisId") long analysisId,
      @Param("roleName") String roleName);

  // L'utilisateur porte-t-il au moins un rôle GLOBAL (User_Role → Role.global_assignable) ?
  // Sert à autoriser la room WebSocket "adminRoles" (liste des administrateurs) : réservée aux
  // porteurs d'un rôle global (Administrateur / Gardien). Calqué sur core DbRoomAuthorizer.
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM User_Role ur
            JOIN Role r ON r.id = ur.role_id
            WHERE ur.user_id = :userId AND r.global_assignable = TRUE
          )
          """,
      nativeQuery = true)
  boolean hasGlobalRole(@Param("userId") long userId);
}
