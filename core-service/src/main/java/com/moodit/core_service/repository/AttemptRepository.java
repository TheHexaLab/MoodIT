package com.moodit.core_service.repository;

import com.moodit.core_service.model.Attempt;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface AttemptRepository extends JpaRepository<Attempt, Integer> {

    /** Tentatives d'un utilisateur sur un quiz, dans l'ordre (1, 2, …). */
    List<Attempt> findByQuiz_IdAndUser_IdOrderByAttemptNoAsc(Integer quizId, Integer userId);

    /** Nombre de tentatives déjà faites (→ numéro de la prochaine, et garde tentative unique). */
    long countByQuiz_IdAndUser_Id(Integer quizId, Integer userId);

    /** Une tentative précise, restreinte à son propriétaire (autorisation). */
    Optional<Attempt> findByIdAndUser_Id(Integer id, Integer userId);

    /**
     * Toutes les tentatives (tous utilisateurs) des quiz d'un cours — agrégat de réussite MCP —
     * avec leur quiz, leur auteur et leurs soumissions (et la question de chacune) dans la MÊME
     * requête : pas de requête par tentative (N+1). Les verdicts de tests des soumissions sont
     * chargés à part ({@link SubmissionRepository#findWithTestCaseResultsByCourseId}) : deux
     * collections {@code List} ne se chargent pas dans une seule requête.
     */
    @Query("SELECT DISTINCT a FROM Attempt a JOIN FETCH a.quiz JOIN FETCH a.user"
            + " LEFT JOIN FETCH a.submissions s LEFT JOIN FETCH s.question"
            + " WHERE a.quiz.course.id = :courseId")
    List<Attempt> findWithSubmissionsByCourseId(@Param("courseId") Integer courseId);
}
