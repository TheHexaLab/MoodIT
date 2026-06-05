package com.moodit.core_service.controller;

//DTO
import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.ProgramDTO;

//Service
import com.moodit.core_service.service.ProgramService;

import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.ResponseEntity;
import java.util.List;

@RestController
@RequestMapping("/programs") // /api/programs
@RequiredArgsConstructor
public class ProgramController {

    private final ProgramService programService;

    //Retourne program
    @GetMapping
    public ResponseEntity<List<ProgramDTO>> findAll() {
        return ResponseEntity.ok(programService.findAll());
    }

    //Retourne course
    @GetMapping("/{programCode}/courses")
    public ResponseEntity<List<CourseDTO>> getCoursesByProgram(@PathVariable String programCode) {
        return ResponseEntity.ok(programService.getCoursesByProgram(programCode));
    }

}
