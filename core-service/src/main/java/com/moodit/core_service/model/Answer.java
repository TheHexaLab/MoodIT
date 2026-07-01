package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

/** Option de réponse (table Answer) — Vrai/Faux, choix unique, choix multiple. */
@Entity
@Data
@Table(name = "answer")
public class Answer {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, length = 512)
    private String content;

    @Column(name = "is_correct", nullable = false)
    private Boolean isCorrect;

    @ManyToOne
    @JoinColumn(name = "question_id", nullable = false)
    private Question question;
}
