package com.moodit.core_service.repository;

import com.moodit.core_service.model.Attempt;

import org.springframework.data.jpa.repository.JpaRepository;
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

    /** Toutes les tentatives (tous utilisateurs) des quiz d'un cours — agrégat de réussite MCP. */
    List<Attempt> findByQuiz_Course_Id(Integer courseId);
}
