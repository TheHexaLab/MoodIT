package com.moodit.core_service.service;

//Model
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Course;

//DTO
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.ProgramCoursesDTO;
import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.CourseCreateDTO;

//Exception
import com.moodit.core_service.exception.ProgramNotFoundException;

import com.moodit.core_service.repository.CourseRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import com.moodit.core_service.repository.ProgramRepository;
import java.util.List;

@Service
@RequiredArgsConstructor
public class ProgramService {

    private final ProgramRepository programRepository;
    private final CourseRepository courseRepository;

    //region Transformations d'Entités (entité BD -> DTO)
    private ProgramDTO toProgramDTO(Program program) {
        ProgramDTO dto = new ProgramDTO();

        dto.setId(program.getId());
        dto.setName(program.getName());
        dto.setCode(program.getCode());
        dto.setCohort(program.getCohort());
        dto.setColor(program.getColor());
        return dto;
    }
    private ProgramCoursesDTO toProgramCoursesDTO(Program program) {
        ProgramCoursesDTO dto = new ProgramCoursesDTO();

        dto.setId(program.getId());
        dto.setName(program.getName());
        dto.setCode(program.getCode());
        dto.setCohort(program.getCohort());
        dto.setColor(program.getColor());
        dto.setCourses(program.getCourses()
                .stream()
                .map(this::toCourseDTO)
                .toList());
        return dto;
    }
    private CourseDTO toCourseDTO(Course course) {
        CourseDTO dto = new CourseDTO();

        dto.setId(course.getId());
        dto.setTitle(course.getTitle());
        dto.setDescription(course.getDescription());
        dto.setCode(course.getCode());
        return dto;
    }
    //endregion

    public List<ProgramDTO> findAll() {
        return programRepository.findAll()
                .stream()
                .map(this::toProgramDTO)
                .toList();
    }
    public List<CourseDTO> getCoursesByProgram(Integer programId) {
        Program program = programRepository.findById(programId)
                .orElseThrow(() -> new ProgramNotFoundException());
        return program.getCourses()
                .stream()
                .map(this::toCourseDTO)
                .toList();
    }

    //POST
    public CourseDTO addCourseToPrograms(CourseCreateDTO courseCreateDTO) {
        Course course = new Course();

        course.setId(courseCreateDTO.getId());
        course.setCode(courseCreateDTO.getCode());
        course.setTitle(courseCreateDTO.getTitle());
        course.setDescription(courseCreateDTO.getDescription());
        List<Program> programs = courseCreateDTO.getProgramIds()
                .stream()
                .map(id -> programRepository.findById(id)
                        .orElseThrow(() -> new ProgramNotFoundException()))
                .toList();
        course.setPrograms(programs);
        courseRepository.save(course);
        return toCourseDTO(course);
    }
}