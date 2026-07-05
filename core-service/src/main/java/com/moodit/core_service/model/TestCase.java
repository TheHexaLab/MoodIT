package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

/**
 * Harnais de test d'une question Code (table test_case). `harnessCode` est le code exécuté
 * contre la soumission de l'étudiant (écrit dans le langage {@code Language.harness_language_id}
 * de la question, ou son propre langage si null). `weight` = crédit partiel. DONNÉES CACHÉES :
 * jamais exposées au répondant.
 */
@Entity
@Data
@Table(name = "test_case")
public class TestCase {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(name = "harness_code", nullable = false, columnDefinition = "TEXT")
    private String harnessCode;

    @Column(nullable = false)
    private Integer weight;

    @ManyToOne
    @JoinColumn(name = "question_id", nullable = false)
    private Question question;
}
