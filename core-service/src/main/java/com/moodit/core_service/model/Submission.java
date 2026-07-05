package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.SourceType;

import java.time.LocalDateTime;
import java.util.List;

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

    @ManyToOne
    @JoinColumn(name = "question_id", nullable = false)
    private Question question;

    @ManyToOne
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    /** Verdicts par harnais (questions Code), écrits par le job de correction. */
    @OneToMany(mappedBy = "submission", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<SubmissionTestCase> testCaseResults;
}
