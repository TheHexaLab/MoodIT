package com.moodit.core_service.repository;

//Model
import com.moodit.core_service.model.Course;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;

@Repository
public interface CourseRepository extends JpaRepository<Course, Integer> {

    /**
     * Supprime, parmi les cours fournis, ceux qui ne sont plus rattachés à AUCUN programme
     * (cours devenus orphelins après la suppression d'un programme). Les cours partagés avec un
     * autre programme sont conservés. Le ON DELETE CASCADE en base emporte le contenu du cours
     * supprimé (forums, quiz, inscriptions, réponses MCP…). À exécuter APRÈS avoir retiré les
     * liens program_course du programme supprimé (flush préalable requis).
     */
    @Modifying
    @Query(
        value =
            """
            DELETE FROM course c
            WHERE c.id IN (:courseIds)
              AND NOT EXISTS (
                SELECT 1 FROM program_course pc WHERE pc.course_id = c.id
              )
            """,
        nativeQuery = true)
    int deleteOrphanedAmong(@Param("courseIds") Collection<Integer> courseIds);
}
