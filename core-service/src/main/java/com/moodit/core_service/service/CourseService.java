package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.*;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.EnrollmentRepository;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class CourseService {

    private final CourseRepository courseRepository;
    private final ForumRepository forumRepository;
    private final ForumService forumService;
    private final ProgramService programService;
    private final UserRepository userRepository;
    private final EnrollmentRepository enrollmentRepository;


    private CourseDTO toCourseDTO(Course course) {
        CourseDTO dto = new CourseDTO();

        dto.setId(course.getId());
        dto.setTitle(course.getTitle());
        dto.setCode(course.getCode());

        return dto;
    }
    public CourseProgramsDTO toCourseProgramsDTO(Course course) {
        CourseProgramsDTO dto = new CourseProgramsDTO();

        dto.setId(course.getId());
        dto.setTitle(course.getTitle());
        dto.setCode(course.getCode());
        dto.setPrograms(course.getPrograms()
                .stream()
                .map(programService::toProgramDTO)
                .toList());

        return dto;
    }

    public CourseForumsDTO toCourseForumsDTO(Course course) {
        CourseForumsDTO dto = new CourseForumsDTO();

        dto.setId(course.getId());
        dto.setTitle(course.getTitle());
        dto.setCode(course.getCode());
        dto.setForums(course.getForums()
                .stream()
                .map(forumService::toForumDTO)
                .toList());

        return dto;
    }


    public CourseDTO findById(Integer id) {
        Course course = courseRepository.findById(id)
                .orElseThrow(CourseNotFoundException::new);

        return toCourseDTO(course);
    }

    public List<ForumDTO> getForumsByCourseId(Integer courseId) {
        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);

        return course.getForums().stream()
                .map(forum -> forumService.findById(forum.getId()))
                .toList();
    }

    public List<ForumDTO> getForumsByCourseAndType(Integer courseId, Integer typeId) {

        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);

        return course.getForums().stream()
                .filter(f -> typeId == null || f.getFType().getId().equals(typeId))
                .map(forumService::toForumDTO)
                .toList();
    }

    public ForumDTO getForumByIdInCourse(Integer courseId, Integer forumId) {

        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);

        Forum forum = course.getForums().stream()
                .filter(f -> f.getId().equals(forumId))
                .findFirst()
                .orElseThrow(() -> new RuntimeException(
                        "Forum not found with id " + forumId +
                                " in course " + courseId
                ));
        return forumService.findById(forum.getId());
    }

    public ForumDTO addForumToCourse(ForumDTO dto) {

        Course course = courseRepository.findById(dto.getCourseId())
                .orElseThrow(CourseNotFoundException::new);

        Forum forum = new Forum();

        forum.setTitle(dto.getTitle());
        forum.setCourse(course);

        FType fType = new FType();
        fType.setId(dto.getFTypeId());

        forum.setPosition(dto.getPosition());

        forum.setFType(fType);

        Forum saved = forumRepository.save(forum);

        return forumService.toForumDTO(saved);
    }

    public CourseDTO updateCourse(Integer courseId, CourseUpdateDTO dto) {

        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);

        if (dto.getTitle() != null) {
            course.setTitle(dto.getTitle());
        }

        if (dto.getCode() != null) {
            course.setCode(dto.getCode());
        }

        Course saved = courseRepository.save(course);

        return toCourseDTO(saved);
    }

    public void deleteCourse(Integer courseId) {
        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);

        courseRepository.delete(course);
    }

    public void addUserToCourses(UserCreateInCoursesDTO dto) {

        User user = userRepository.findById(dto.getId())
                .orElseThrow(UserNotFoundException::new);

        Set<Integer> existingCourseIds = user.getEnrollments().stream()
                .map(e -> e.getCourse().getId())
                .collect(Collectors.toSet());

        List<Course> coursesToAdd = dto.getCourseIds().stream()
                .distinct()
                .filter(id -> !existingCourseIds.contains(id))
                .map(id -> courseRepository.findById(id)
                        .orElseThrow(CourseNotFoundException::new))
                .toList();

        for (Course course : coursesToAdd) {
            Enrollment enrollment = new Enrollment();
            enrollment.setUser(user);
            enrollment.setCourse(course);
            enrollment.setEnrolledAt(LocalDateTime.now());

            enrollmentRepository.save(enrollment);
        }

        userRepository.save(user);
    }

}

