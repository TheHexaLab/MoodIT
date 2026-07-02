package com.moodit.core_service.repository;

import com.moodit.core_service.model.Quiz;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface QuizRepository extends JpaRepository<Quiz, Integer> {

    /** Nombre de quiz d'un cours (contexte d'analyse MCP). */
    long countByCourse_Id(Integer courseId);
}
