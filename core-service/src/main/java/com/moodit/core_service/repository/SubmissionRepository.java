package com.moodit.core_service.repository;

import com.moodit.core_service.model.Submission;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface SubmissionRepository extends JpaRepository<Submission, Integer> {

    /** Nombre de soumissions de cet utilisateur pour les questions d'un quiz (tentative unique). */
    long countByUser_IdAndQuestion_Quiz_Id(Integer userId, Integer quizId);

    /** Soumissions de cet utilisateur pour les questions d'un quiz (réhydratation du résultat). */
    List<Submission> findByUser_IdAndQuestion_Quiz_Id(Integer userId, Integer quizId);
}
