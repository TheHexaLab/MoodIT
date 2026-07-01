package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

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

    @Column(name = "total_score", nullable = false)
    private Integer totalScore;

    @ManyToOne
    @JoinColumn(name = "q_type_id", nullable = false)
    private QType qType;

    @ManyToOne
    @JoinColumn(name = "quiz_id", nullable = false)
    private Quiz quiz;

    @OneToMany(mappedBy = "question", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<Answer> answers;

    @OneToMany(mappedBy = "question", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<DragItem> dragItems;
}
