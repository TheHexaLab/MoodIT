package com.moodit.mcp_service.repository;

import com.moodit.mcp_service.model.User;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface UserRepository extends JpaRepository<User, Integer> {

    /** Résout l'utilisateur courant à partir de l'email injecté par le gateway. */
    Optional<User> findByEmail(String email);

    /**
     * L'utilisateur a-t-il un rôle PROGRAMME (User_Program_Role) « Administrateur » ou
     * « Enseignant » dans un programme QUI CONTIENT ce cours ? Scope indispensable : un
     * enseignant d'un autre programme ne doit pas accéder au MCP de ce cours.
     */
    @Query(
            value =
                    """
                    SELECT EXISTS(
                      SELECT 1
                      FROM user_program_role upr
                      JOIN role r            ON r.id = upr.role_id
                      JOIN program_course pc ON pc.program_id = upr.program_id
                      WHERE upr.user_id = :userId
                        AND pc.course_id = :courseId
                        AND r.name IN ('Administrateur', 'Enseignant')
                    )
                    """,
            nativeQuery = true)
    boolean hasProgramTeachingRoleForCourse(
            @Param("userId") Integer userId, @Param("courseId") Integer courseId);
}
