package com.moodit.core_service.repository;

import com.moodit.core_service.model.Enrollment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.List;

@Repository
public interface EnrollmentRepository extends JpaRepository<Enrollment, Integer> {

    // Check if a user is already enrolled in a course
    Optional<Enrollment> findByUserIdAndCourseId(Integer userId, Integer courseId);

    // Get all enrollments of a user
    List<Enrollment> findByUserId(Integer userId);

    // Get all enrollments of a course
    List<Enrollment> findByCourseId(Integer courseId);
}