package com.moodit.core_service.controller;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.service.EstablishmentService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/establishments")
@RequiredArgsConstructor
public class EstablishmentController {

    private final EstablishmentService establishmentService;


    @GetMapping
    public ResponseEntity<List<EstablishmentSimpleDTO>> findAll() {
        return ResponseEntity.ok(establishmentService.findAll());
    }


    @GetMapping("/{establishmentId}/programs")
    public ResponseEntity<List<ProgramDTO>> getProgramsByEstablishment(
            @PathVariable Integer establishmentId) {

        return ResponseEntity.ok(
                establishmentService.getProgramsByEstablishment(establishmentId)
        );
    }


    @PostMapping("/{establishmentId}/programs")
    public ResponseEntity<EstablishmentDTO> addProgramToEstablishment(
            @PathVariable Integer establishmentId,
            @RequestBody Program program) {

        return ResponseEntity.ok(
                establishmentService.addProgramToEstablishment(establishmentId, program)
        );
    }
}
