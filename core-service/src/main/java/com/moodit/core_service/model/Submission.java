package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * Soumission d'un étudiant à UNE question (table Submission). UNIQUE(user, question) :
 * une seule tentative par question (donc par quiz) — empêche de refaire un quiz.
 */
@Entity
@Data
@Table(
        name = "submission",
        uniqueConstraints = @UniqueConstraint(columnNames = {"user_id", "question_id"})
)
public class Submission {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    /** Réponse brute soumise (sérialisée), pour audit / révision. */
    @Column(columnDefinition = "TEXT")
    private String content;

    @Column(name = "submitted_at", nullable = false)
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
