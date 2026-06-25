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
        return ProgramDTO.builder()
                .id(program.getId())
                .name(program.getName())
                .code(program.getCode())
                .cohort(program.getCohort())
                .color(program.getColor())
                .build();
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
        if (programId == null) {
            throw new IllegalArgumentException();
        }

        Program program = programRepository.findById(programId)
                .orElseThrow(ProgramNotFoundException::new);

        return toProgramDTO(program);
    }
    public ProgramCoursesDTO getCoursesByProgram(Integer programId) {
        if (programId == null) {
            throw new IllegalArgumentException();
        }

        Program program = programRepository.findById(programId)
                .orElseThrow(ProgramNotFoundException::new);

        return toProgramCoursesDTO(program);
    }
    public CourseDTO getCourseByProgram(Integer programId, Integer courseId) {
        if (programId == null || courseId == null) {
            throw new IllegalArgumentException();
        }

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
        if (courseCreateDTO == null ||  courseCreateDTO.getProgramIds() == null) {
            throw new IllegalArgumentException();
        }

        List<Program> programs = courseCreateDTO.getProgramIds()
                .stream()
                .distinct()
                .map(id -> programRepository.findById(id)
                        .orElseThrow(ProgramNotFoundException::new))
                .toList();

        Course course = Course.builder()
                .code(courseCreateDTO.getCode())
                .title(courseCreateDTO.getTitle())
                .forums(List.of())
                .programs(List.of())
                .build();

        courseRepository.save(course);

        programs.forEach(p -> p.getCourses().add(course));
        programRepository.saveAll(programs);

        return toCourseDTO(course);
    }
    public void addUserToPrograms(UserCreateInProgramsDTO userCreateDTO) {
        if (userCreateDTO == null ||  userCreateDTO.getProgramIds() == null) {
            throw new IllegalArgumentException();
        }
        User user = userRepository.findById(userCreateDTO.getId())
                .orElseThrow(() -> new UserNotFoundException());
        List<Program> programs = userCreateDTO.getProgramIds()
                .stream()
                .distinct()
                .map(id -> programRepository.findById(id)
                        .orElseThrow(() -> new ProgramNotFoundException()))
                .toList();
        user.getPrograms().addAll(programs);
        userRepository.save(user);
    }
    //endregion

    //region PATCH
    public ProgramDTO updateProgram(Integer programId, ProgramUpdateDTO programUpdateDTO) {
        if (programId == null || programUpdateDTO == null) {
            throw new IllegalArgumentException("L'identifiant et le DTO ne peuvent pas être nuls");
        }

        Program program = programRepository.findById(programId)
                .orElseThrow(() -> new ProgramNotFoundException());
        if (programUpdateDTO.getName() != null) {
            program.setName(programUpdateDTO.getName());
        }
        if (programUpdateDTO.getCode() != null) {
            program.setCode(programUpdateDTO.getCode());
        }
        if (programUpdateDTO.getCohort() != null) {
            program.setCohort(programUpdateDTO.getCohort());
        }
        if (programUpdateDTO.getColor() != null) {
            program.setColor(programUpdateDTO.getColor());
        }

        programRepository.save(program);
        return toProgramDTO(program);
    }
    //endregion
}