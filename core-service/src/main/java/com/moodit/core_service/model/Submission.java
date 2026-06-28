package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.SourceType;

import java.time.LocalDateTime;

/**
 * Soumission d'un étudiant à UNE question, rattachée à une tentative (table Submission).
 * UNIQUE(attempt, question) : une seule réponse par question dans une tentative donnée.
 */
@Entity
@Data
@Table(
        name = "submission",
        uniqueConstraints = @UniqueConstraint(columnNames = {"attempt_id", "question_id"})
)
public class Submission {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @ManyToOne
    @JoinColumn(name = "attempt_id", nullable = false)
    private Attempt attempt;

    /** Réponse brute soumise (sérialisée), pour audit / révision. */
    @Column(columnDefinition = "TEXT")
    private String content;

    @CreationTimestamp(source = SourceType.DB)
    @Column(name = "submitted_at", nullable = false, updatable = false)
    private LocalDateTime submittedAt;

    /** Points obtenus à la question (corrigés au moment de la soumission). */
    private Integer score;

    @ManyToOne
    @JoinColumn(name = "question_id", nullable = false)
    private Question question;

    @ManyToOne
    @JoinColumn(name = "user_id", nullable = false)
    private User user;
}
