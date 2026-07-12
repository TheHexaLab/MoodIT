package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

/**
 * Verdict d'UN harnais pour UNE soumission de code (table submission_test_case). Clé composite
 * (submission, test_case). `passed` est écrit par le job de correction de code (exécution
 * sandbox), puis relu pour calculer le score de la question Code.
 */
@Entity
@Data
@Table(name = "submission_test_case")
@IdClass(SubmissionTestCaseId.class)
public class SubmissionTestCase {

    @Id
    @ManyToOne
    @JoinColumn(name = "submission_id")
    private Submission submission;

    @Id
    @ManyToOne
    @JoinColumn(name = "test_case_id")
    private TestCase testCase;

    @Column(nullable = false)
    private Boolean passed;
}
