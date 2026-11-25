package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;
import java.util.Objects;

/**
 * Échecs de correction SANS VERDICT d'un étudiant sur un quiz (#116, S4 ; table grading_failure).
 * Le conteneur runner a tourné sans rendre de verdict ; la tentative échouée est supprimée, le
 * compte vit donc ici. Dès que le compte atteint le plafond, la tentative est gardée « à revoir »
 * au lieu d'être supprimée (cf. QuizService#failGrading).
 */
@Entity
@Data
@Table(name = "grading_failure")
@IdClass(GradingFailure.Key.class)
public class GradingFailure {

    @Id
    @Column(name = "quiz_id")
    private Integer quizId;

    @Id
    @Column(name = "user_id")
    private Integer userId;

    @Column(name = "no_verdict_count", nullable = false)
    private Integer noVerdictCount;

    @Column(name = "last_failure_at", nullable = false)
    private LocalDateTime lastFailureAt;

    /** Clé composite (quiz_id, user_id), même forme que {@link SubmissionTestCaseId}. */
    public static class Key implements Serializable {
        private Integer quizId;
        private Integer userId;

        public Key() {}

        public Key(Integer quizId, Integer userId) {
            this.quizId = quizId;
            this.userId = userId;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Key that && Objects.equals(quizId, that.quizId)
                    && Objects.equals(userId, that.userId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(quizId, userId);
        }
    }
}
