package com.moodit.core_service.controller;

//DTO
import com.moodit.core_service.dto.CourseCreateDTO;
import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.ProgramDTO;

//Service
import com.moodit.core_service.service.CourseService;
import com.moodit.core_service.service.ProgramService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import java.util.List;

@RestController
@RequestMapping("/programs") // /api/programs
@RequiredArgsConstructor
public class ProgramController {

    private final ProgramService programService;
    private final CourseService courseService;


    //region GET
    //Retourne program
    @GetMapping
    public ResponseEntity<List<ProgramDTO>> findAll() {
        return ResponseEntity.ok(programService.findAll());
    }

    //Retourne courses d'un programme
    @GetMapping("/{programId}/courses")
    public ResponseEntity<List<CourseDTO>> getCoursesByProgram(@PathVariable Integer programId) {
        return ResponseEntity.ok(programService.getCoursesByProgram(programId));
    }
    //endregion

    //Ajouter un cours dans des programmes
    @PostMapping("/courses")
    public ResponseEntity<CourseDTO> addCourseToPrograms(@RequestBody CourseCreateDTO courseCreateDTO) {
        return ResponseEntity.ok(programService.addCourseToPrograms(courseCreateDTO));
    }

}
