package com.moodit.core_service.controller;

//Model
import com.moodit.core_service.model.Course;

//Service
import com.moodit.core_service.service.CourseService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/courses")
@RequiredArgsConstructor

public class CourseController {

    private final CourseService courseService;


}
