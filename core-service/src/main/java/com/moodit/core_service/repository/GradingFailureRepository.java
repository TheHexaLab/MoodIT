package com.moodit.core_service.repository;

import com.moodit.core_service.model.GradingFailure;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

/** Échecs de correction sans verdict, par (quiz, étudiant) — #116, S4. */
@Repository
public interface GradingFailureRepository extends JpaRepository<GradingFailure, GradingFailure.Key> {
}
