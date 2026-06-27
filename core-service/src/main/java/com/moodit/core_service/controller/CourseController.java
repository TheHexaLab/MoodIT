package com.moodit.core_service.controller;

//Model
import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.CourseUpdateDTO;
import com.moodit.core_service.dto.ForumDTO;

//Service
import com.moodit.core_service.dto.UserCreateInCoursesDTO;
import com.moodit.core_service.service.CourseService;

import com.moodit.core_service.service.ForumService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/courses")
@RequiredArgsConstructor

public class CourseController {

    private final CourseService courseService;
    private final ForumService forumService;


    @GetMapping("/{courseId}")
    public ResponseEntity<?> findCourse(@PathVariable Integer courseId) {
        return ResponseEntity.ok(courseService.findById(courseId));
    }

    @GetMapping("/{courseId}/forums")
    public ResponseEntity<List<ForumDTO>> getForumsByCourse(
            @PathVariable Integer courseId, @RequestParam(required = false) Integer typeId) {

        return ResponseEntity.ok(
                courseService.getForumsByCourseAndType(courseId, typeId)
        );
    }

    @GetMapping("/{courseId}/forums/{forumId}")
    public ResponseEntity<ForumDTO> getForumByCourseAndId(
            @PathVariable Integer courseId,
            @PathVariable Integer forumId) {

        return ResponseEntity.ok(
                courseService.getForumByIdInCourse(courseId, forumId)
        );
    }

    @PostMapping("/forums")
    public ResponseEntity<ForumDTO> addForumToCourse(@RequestBody ForumDTO request) {

        return ResponseEntity.ok(
                courseService.addForumToCourse(request)
        );
    }

    @PostMapping("/users")
    public ResponseEntity<Void> addUserToCourses(
            @RequestBody UserCreateInCoursesDTO request) {

        courseService.addUserToCourses(request);
        return ResponseEntity.status(201).build();
    }

    @PatchMapping("/{courseId}")
    public ResponseEntity<CourseDTO> updateCourse(
            @PathVariable Integer courseId,
            @RequestBody CourseUpdateDTO request) {

        return ResponseEntity.ok(
                courseService.updateCourse(courseId, request)
        );
    }

    @DeleteMapping("/{courseId}")
    public ResponseEntity<Void> deleteCourse(@PathVariable Integer courseId) {
        courseService.deleteCourse(courseId);
        return ResponseEntity.noContent().build();
    }
}
