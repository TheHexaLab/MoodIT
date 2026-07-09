package com.moodit.core_service.repository;

import com.moodit.core_service.model.Enrollment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.List;

@Repository
public interface EnrollmentRepository extends JpaRepository<Enrollment, Integer> {

    // Check if a user is already enrolled in a course
    Optional<Enrollment> findByUserIdAndCourseId(Integer userId, Integer courseId);

    // Get all enrollments of a user
    List<Enrollment> findByUserId(Integer userId);

    // Get all enrollments of a course
    List<Enrollment> findByCourseId(Integer courseId);

    // Nombre d'étudiants inscrits à un cours (contexte d'analyse MCP)
    long countByCourseId(Integer courseId);

    /**
     * Retire les inscriptions d'un utilisateur aux cours d'un programme qu'il QUITTE — mais SEULEMENT
     * celles devenues inaccessibles : un cours partagé avec un autre programme encore rejoint reste
     * accessible, donc son inscription est conservée. À exécuter APRÈS avoir retiré le User_Program
     * du programme quitté (le second NOT IN reflète alors les programmes RESTANTS).
     */
    @Modifying
    @Query(
        value =
            """
            DELETE FROM enrollment e
            WHERE e.user_id = :userId
              AND e.course_id IN (
                SELECT pc.course_id FROM program_course pc WHERE pc.program_id = :programId
              )
              AND e.course_id NOT IN (
                SELECT pc2.course_id
                FROM program_course pc2
                JOIN user_program up ON up.program_id = pc2.program_id
                WHERE up.user_id = :userId
              )
            """,
        nativeQuery = true)
    int deleteForUserLeavingProgram(
        @Param("userId") Integer userId, @Param("programId") Integer programId);
}