package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.SourceType;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Une tentative de quiz par un utilisateur (regroupe les soumissions de la tentative).
 * `attemptNo` = 1, 2, … par (quiz, user) ; plusieurs tentatives ne sont créées que si
 * Quiz.allowRetry (contrôlé dans le service).
 */
@Entity
@Data
@Table(
        name = "attempt",
        uniqueConstraints = @UniqueConstraint(columnNames = {"quiz_id", "user_id", "attempt_no"})
)
public class Attempt {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @ManyToOne
    @JoinColumn(name = "quiz_id", nullable = false)
    private Quiz quiz;

    @ManyToOne
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Column(name = "attempt_no", nullable = false)
    private Integer attemptNo;

    /**
     * Cycle de vie de la correction (soumission asynchrone) : {@code "pending"} pendant que le
     * sandbox corrige le code, {@code "done"} une fois la tentative corrigée et consultable. Une
     * tentative dont l'évaluation code échoue est SUPPRIMÉE (jamais persistée en {@code "failed"}).
     * Défaut {@code "done"} : une tentative créée hors du flux async (seed) est déjà corrigée.
     */
    @Column(name = "status", nullable = false, length = 16)
    private String status = "done";

    @CreationTimestamp(source = SourceType.DB)
    @Column(name = "submitted_at", updatable = false)
    private LocalDateTime submittedAt;

    @OneToMany(mappedBy = "attempt", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<Submission> submissions;
}
