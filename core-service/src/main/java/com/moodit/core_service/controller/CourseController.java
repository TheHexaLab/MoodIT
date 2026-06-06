package com.moodit.core_service.controller;

//Model
import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.model.Course;

//Service
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.service.CourseService;

import com.moodit.core_service.service.ForumService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

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
            @PathVariable Integer courseId) {

        return ResponseEntity.ok(
                courseService.getForumsByCourseId(courseId)
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
}
