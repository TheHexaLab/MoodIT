package com.moodit.core_service.model;

import java.io.Serializable;
import java.util.Objects;

/** Clé composite de {@link SubmissionTestCase} : (submission_id, test_case_id). */
public class SubmissionTestCaseId implements Serializable {

    private Integer submission;
    private Integer testCase;

    public SubmissionTestCaseId() {}

    public SubmissionTestCaseId(Integer submission, Integer testCase) {
        this.submission = submission;
        this.testCase = testCase;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof SubmissionTestCaseId that)) return false;
        return Objects.equals(submission, that.submission) && Objects.equals(testCase, that.testCase);
    }

    @Override
    public int hashCode() {
        return Objects.hash(submission, testCase);
    }
}
