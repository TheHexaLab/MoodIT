package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

/**
 * Harnais de test d'une question Code (table test_case) : {@code harnessCode} est un TEST
 * exécutable contre la soumission. Interprétés/SQL/vues : code qui renvoie vrai/faux, dans le
 * langage {@code Language.harness_language_id} ou celui de la question. Langages COMPILÉS (#116) :
 * un VRAI test du langage (JUnit, NUnit, go test, cargo test, moodit_check.h), noté par le runner
 * Docker isolé d'execution-service (code étudiant sous UID dédié, harnais verrouillé, canaris
 * anti-falsification). {@code weight} = crédit partiel. DONNÉES CACHÉES : jamais exposées au
 * répondant.
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

    /** Code du harnais exécuté contre la soumission (renvoie vrai/faux). */
    // NOT NULL rétabli en base par V6 (chaque harnais porte son code) : l'entité suit.
    @Column(name = "harness_code", nullable = false, columnDefinition = "TEXT")
    private String harnessCode;

    @Column(nullable = false)
    private Integer weight;

    @ManyToOne
    @JoinColumn(name = "question_id", nullable = false)
    private Question question;
}
