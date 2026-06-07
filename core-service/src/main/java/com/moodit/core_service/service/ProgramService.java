package com.moodit.core_service.service;

//Model
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.User;

//DTO
import com.moodit.core_service.dto.*;

//Exception
import com.moodit.core_service.exception.ProgramNotFoundException;
import com.moodit.core_service.exception.CourseNotFoundException;

import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.ProgramRepository;
import com.moodit.core_service.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import java.util.List;

@Service
@RequiredArgsConstructor
public class ProgramService {

    private final ProgramRepository programRepository;
    private final CourseRepository courseRepository;
    private final UserRepository userRepository;

    //region Transformations d'Entités (entité BD -> DTO)
    public ProgramDTO toProgramDTO(Program program) {
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

    //region GET
    public List<ProgramDTO> findAll() {
        return programRepository.findAll()
                .stream()
                .map(this::toProgramDTO)
                .toList();
    }
    public ProgramDTO findById(Integer programId) {
        return programRepository.findById(programId)
                .map(this::toProgramDTO)
                .orElseThrow(() -> new ProgramNotFoundException());

    }
    public List<CourseDTO> getCoursesByProgram(Integer programId) {
        Program program = programRepository.findById(programId)
                .orElseThrow(() -> new ProgramNotFoundException());
        return program.getCourses()
                .stream()
                .map(this::toCourseDTO)
                .toList();
    }
    public CourseDTO getCourseByProgram(Integer programId, Integer courseId) {
        Program program = programRepository.findById(programId)
                .orElseThrow(() -> new ProgramNotFoundException());
    return program.getCourses()
            .stream()
            .filter(c -> c.getId().equals(courseId))
            .findFirst()
            .map(this::toCourseDTO)
            .orElseThrow(() -> new CourseNotFoundException());
    }
    //endregion

    //region POST
    public CourseDTO addCourseToPrograms(CourseCreateInProgramsDTO courseCreateDTO) {
        Course course = new Course();

        course.setCode(courseCreateDTO.getCode());
        course.setTitle(courseCreateDTO.getTitle());
        course.setDescription(courseCreateDTO.getDescription());
        courseRepository.save(course);
        List<Program> programs = courseCreateDTO.getProgramIds()
                .stream()
                .map(id -> programRepository.findById(id)
                        .orElseThrow(() -> new ProgramNotFoundException()))
                .toList();

        programs.forEach(p -> p.getCourses().add(course));
        programRepository.saveAll(programs);
        return toCourseDTO(course);
    }
    public void addUserToPrograms(UserCreateInProgramsDTO userCreateDTO) {
        User user = userRepository.findById(userCreateDTO.getId())
                .orElseThrow(() -> new UserNotFoundException());
        List<Program> programs = userCreateDTO.getProgramIds()
                .stream()
                .map(id -> programRepository.findById(id)
                        .orElseThrow(() -> new ProgramNotFoundException()))
                .toList();
        user.getPrograms().addAll(programs);
        userRepository.save(user);
    }
    //endregion
}