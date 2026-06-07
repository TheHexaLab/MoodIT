package com.moodit.core_service.service;

import com.moodit.core_service.dto.CourseCreateInProgramsDTO;
import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.CourseProgramsDTO;
import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.ForumRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class CourseService {

    private final CourseRepository courseRepository;
    private final ForumService forumService;
    private final ProgramService programService;

    //region Transformations d'Entités (entité BD -> DTO)
    private CourseDTO toCourseDTO(Course course) {
        CourseDTO dto = new CourseDTO();

        dto.setId(course.getId());
        dto.setTitle(course.getTitle());
        dto.setDescription(course.getDescription());
        dto.setCode(course.getCode());

        return dto;
    }
    public CourseProgramsDTO toCourseProgramsDTO(Course course) {
        CourseProgramsDTO dto = new CourseProgramsDTO();

        dto.setId(course.getId());
        dto.setTitle(course.getTitle());
        dto.setDescription(course.getDescription());
        dto.setCode(course.getCode());
        dto.setPrograms(course.getPrograms()
                .stream()
                .map(programService::toProgramDTO)
                .toList());

        return dto;
    }
    //endregion

    public CourseDTO findById(Integer id) {
        Course course = courseRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("Course not found"));

        return toCourseDTO(course);
    }

    public List<ForumDTO> getForumsByCourseId(Integer courseId) {
        Course course = courseRepository.findById(courseId)
                .orElseThrow(() -> new RuntimeException("Course not found"));

        return course.getForums().stream()
                .map(forum -> forumService.findById(forum.getId()))
                .toList();
    }

    public ForumDTO getForumByIdInCourse(Integer courseId, Integer forumId) {

        Course course = courseRepository.findById(courseId)
                .orElseThrow(() -> new RuntimeException("Course not found"));

        Forum forum = course.getForums().stream()
                .filter(f -> f.getId().equals(forumId))
                .findFirst()
                .orElseThrow(() -> new RuntimeException(
                        "Forum not found with id " + forumId +
                                " in course " + courseId
                ));
        return forumService.findById(forum.getId());
    }
}