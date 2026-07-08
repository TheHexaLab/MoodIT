package com.moodit.core_service.repository;

import com.moodit.core_service.model.SubmissionTestCase;
import com.moodit.core_service.model.SubmissionTestCaseId;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface SubmissionTestCaseRepository
        extends JpaRepository<SubmissionTestCase, SubmissionTestCaseId> {
}
