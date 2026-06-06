package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.model.Establishment;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.repository.EstablishmentRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class EstablishmentService {

    private final EstablishmentRepository establishmentRepository;
    private final ProgramService programService;

    private EstablishmentSimpleDTO establishmentSimpleToDTO(Establishment est) {

        EstablishmentSimpleDTO dto = new EstablishmentSimpleDTO();
        dto.setId(est.getId());
        dto.setName(est.getName());
        dto.setDomainEmail(est.getDomainEmail());

        return dto;
    }

    private EstablishmentDTO establishmentToDTO(Establishment est) {

        EstablishmentDTO dto = new EstablishmentDTO();
        dto.setId(est.getId());
        dto.setName(est.getName());
        dto.setDomainEmail(est.getDomainEmail());

        dto.setPrograms(
                est.getPrograms()
                        .stream()
                        .map(programService::toProgramDTO)
                        .toList()
        );

        return dto;
    }

    public List<EstablishmentSimpleDTO> findAll() {
        return establishmentRepository.findAll()
                .stream()
                .map(this::establishmentSimpleToDTO)
                .toList();
    }


    public List<ProgramDTO> getProgramsByEstablishment(Integer establishmentId) {

        Establishment est = establishmentRepository.findById(establishmentId)
                .orElseThrow(() -> new RuntimeException("Establishment not found"));

        return est.getPrograms()
                .stream()
                .map(programService::toProgramDTO)
                .toList();
    }


    public EstablishmentDTO addProgramToEstablishment(Integer establishmentId, Program program) {

        Establishment est = establishmentRepository.findById(establishmentId)
                .orElseThrow(() -> new RuntimeException("Establishment not found"));

        program.setEstablishment(est);

        est.getPrograms().add(program);

        establishmentRepository.save(est);

        return establishmentToDTO(est);
    }
}