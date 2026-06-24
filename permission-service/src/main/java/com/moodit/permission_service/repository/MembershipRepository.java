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

  // L'utilisateur est inscrit directement au cours du forum (Enrollment).
  @Query(
      value =
          """
          SELECT EXISTS(
            SELECT 1
            FROM Enrollment e
            JOIN Forum f ON f.course_id = e.course_id
            WHERE f.id = :forumId AND e.user_id = :userId
          )
          """,
      nativeQuery = true)
  boolean isEnrolledInForumCourse(@Param("userId") long userId, @Param("forumId") long forumId);
}
