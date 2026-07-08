package com.moodit.core_service.controller;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.service.EstablishmentService;
import com.moodit.core_service.service.ProgramService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/establishments")
@RequiredArgsConstructor
public class EstablishmentController {

    private final EstablishmentService establishmentService;
    private final ProgramService programService;


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

    /**
     * Programmes de l'établissement dans lesquels l'utilisateur peut AJOUTER un cours : ceux où il
     * est Administrateur/Enseignant (User_Program_Role) ; un admin global / gardien les voit tous.
     * Alimente le popup « Créer un cours ». `X-User-Email` injecté par la gateway (JWT).
     */
    @GetMapping("/{establishmentId}/manageable-programs")
    public ResponseEntity<List<ProgramDTO>> getManageablePrograms(
            @PathVariable Integer establishmentId,
            @RequestHeader("X-User-Email") String email) {

        return ResponseEntity.ok(
                programService.getManageableProgramsInEstablishment(establishmentId, email)
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
