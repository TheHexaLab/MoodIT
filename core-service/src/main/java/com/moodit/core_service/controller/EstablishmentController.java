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
    public ResponseEntity<List<EstablishmentDTO>> findAll() {
        return ResponseEntity.ok(establishmentService.findAll());
    }


    @GetMapping("/{establishmentId}/programs")
    public ResponseEntity<List<ProgramDTO>> getProgramsByEstablishment(
            @PathVariable Integer establishmentId) {

        return ResponseEntity.ok(
                establishmentService.getProgramsByEstablishment(establishmentId)
        );
    }

    @PostMapping
    public ResponseEntity<EstablishmentDTO> createEstablishment(
            @RequestBody EstablishmentDTO dto) {

        return ResponseEntity.status(201).body(
                establishmentService.create(dto)
        );
    }

    @PostMapping("/programs")
    public ResponseEntity<ProgramDTO> addProgramToEstablishment(
            @RequestBody ProgramCreateInEstablishmentDTO request) {

        return ResponseEntity.status(201).body(
                establishmentService.addProgramToEstablishment(request)
        );
    }

    @PatchMapping("/{establishmentId}")
    public ResponseEntity<EstablishmentDTO> updateEstablishment(
            @PathVariable Integer establishmentId,
            @RequestBody EstablishmentUpdateDTO request) {

        return ResponseEntity.ok(
                establishmentService.updateEstablishment(establishmentId, request)
        );
    }

    @DeleteMapping("/{establishmentId}")
    public ResponseEntity<Void> deleteEstablishment(@PathVariable Integer establishmentId) {
        establishmentService.deleteEstablishment(establishmentId);
        return ResponseEntity.noContent().build();
    }
}
