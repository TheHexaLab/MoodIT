package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

/**
 * Harnais de test d'une question Code (table test_case) : {@code harnessCode} est exécuté contre la
 * soumission (renvoie vrai/faux). Les langages compilés sont notés en DEUX processus isolés par
 * execution-service (code étudiant isolé, nonce/verdict dans le parent — POO comprise). Le harnais
 * est écrit dans le langage {@code Language.harness_language_id} ou celui de la question.
 * {@code weight} = crédit partiel. DONNÉES CACHÉES : jamais exposées au répondant.
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
    @Column(name = "harness_code", columnDefinition = "TEXT")
    private String harnessCode;

    @Column(nullable = false)
    private Integer weight;

    @ManyToOne
    @JoinColumn(name = "question_id", nullable = false)
    private Question question;
}
