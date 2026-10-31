package com.moodit.core_service.repository;

import com.moodit.core_service.model.Submission;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface SubmissionRepository extends JpaRepository<Submission, Integer> {

    /** Nombre de soumissions de cet utilisateur pour les questions d'un quiz (tentative unique). */
    long countByUser_IdAndQuestion_Quiz_Id(Integer userId, Integer quizId);

    /** Soumissions de cet utilisateur pour les questions d'un quiz (réhydratation du résultat). */
    List<Submission> findByUser_IdAndQuestion_Quiz_Id(Integer userId, Integer quizId);

    /**
     * Soumissions de toutes les tentatives des quiz d'un cours, avec leurs verdicts de tests (et
     * le cas de test de chacun) en UNE requête. Complète
     * {@link AttemptRepository#findWithSubmissionsByCourseId} : charge en lot les verdicts des
     * soumissions déjà en mémoire, au lieu d'une requête par soumission.
     */
    @Query("SELECT DISTINCT s FROM Submission s LEFT JOIN FETCH s.testCaseResults r"
            + " LEFT JOIN FETCH r.testCase WHERE s.attempt.quiz.course.id = :courseId")
    List<Submission> findWithTestCaseResultsByCourseId(@Param("courseId") Integer courseId);
}
