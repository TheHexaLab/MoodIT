package com.moodit.core_service.service;

//Model
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Course;

//DTO
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.CourseDTO;

//Exception
import com.moodit.core_service.exception.ProgramNotFoundException;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import com.moodit.core_service.repository.ProgramRepository;
import java.util.List;

@Service
@RequiredArgsConstructor
public class ProgramService {

    private final ProgramRepository programRepository;

    //region Transformations d'Entités (entité BD -> DTO)
    private ProgramDTO toProgramDTO(Program program) {
        ProgramDTO dto = new ProgramDTO();

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

    /*public List<Program> findAll() {
        return programRepository.findAll();
    }*/
    public List<ProgramDTO> findAll() {
        return programRepository.findAll()
                .stream()
                .map(this::toProgramDTO)
                .toList();
    }
    public List<CourseDTO> getCoursesByProgram(String programCode) {
        Program program = programRepository.findByCode(programCode)
                .orElseThrow(() -> new ProgramNotFoundException(programCode));
        return program.getCourses()
                .stream()
                .map(this::toCourseDTO)
                .toList();
    }

    /*public List<Course> getCoursesByProgram(String programCode) {
        Program program = programRepository.findByCode(programCode)
                .orElseThrow(() -> new ProgramNotFoundException(programCode));
        return program.getCourses();
    }*/
}