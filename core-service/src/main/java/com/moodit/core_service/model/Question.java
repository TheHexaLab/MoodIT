package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.util.List;

/**
 * Question d'un quiz (table Question). Les champs de support dépendent du type :
 * choix → answers ; ordering/matching → dragItems ; code → start_code + test cases
 * (non mappés ici, jamais renvoyés au répondant).
 */
@Entity
@Data
@Table(name = "question")
public class Question {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, columnDefinition = "TEXT")
    private String prompt;

    @Column(name = "start_code", columnDefinition = "TEXT")
    private String startCode;

    @Column(name = "order_index")
    private Integer orderIndex;

    // NUMERIC(4,1) dans init.sql : sans le type explicite, Hibernate attend un float8 et
    // `ddl-auto=validate` (profil prod) refuse de démarrer.
    @Column(name = "total_score", nullable = false, precision = 4, scale = 1)
    @JdbcTypeCode(SqlTypes.NUMERIC)
    private Double totalScore;

    @ManyToOne
    @JoinColumn(name = "q_type_id", nullable = false)
    private QType qType;

    /** Langage d'exécution — uniquement pour les questions Code (null sinon). */
    @ManyToOne
    @JoinColumn(name = "language_id")
    private Language language;

    @ManyToOne
    @JoinColumn(name = "quiz_id", nullable = false)
    private Quiz quiz;

    @OneToMany(mappedBy = "question", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<Answer> answers;

    @OneToMany(mappedBy = "question", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<DragItem> dragItems;

    /** Harnais de test — uniquement pour les questions Code (données cachées au répondant). */
    @OneToMany(mappedBy = "question", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<TestCase> testCases;
}
