package com.moodit.core_service.service;

//Model
import com.moodit.core_service.model.Course;

//Repository
import com.moodit.core_service.repository.CourseRepository;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import java.util.List;

@Service
@RequiredArgsConstructor
public class CourseService {

    private final CourseRepository courseRepository;

}