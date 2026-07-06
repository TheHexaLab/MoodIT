package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.EstablishmentNotFoundException;
import com.moodit.core_service.model.Establishment;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.repository.EstablishmentRepository;
import com.moodit.core_service.repository.ProgramRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class EstablishmentService {

    private final EstablishmentRepository establishmentRepository;
    private final ProgramService programService;
    private final ProgramRepository programRepository;

    private EstablishmentDTO establishmentToDTO(Establishment est) {

        EstablishmentDTO dto = new EstablishmentDTO();
        dto.setId(est.getId());
        dto.setName(est.getName());
        dto.setDomainEmail(est.getDomainEmail());
        dto.setProgramCount(est.getPrograms() == null ? 0 : est.getPrograms().size());
        dto.setProgramCodes(est.getPrograms() == null ? List.of()
                : est.getPrograms().stream().map(Program::getCode).toList());

        return dto;
    }

    private EstablishmentProgramsDTO establishmentProgramsDTO(Establishment est) {

        EstablishmentProgramsDTO dto = new EstablishmentProgramsDTO();
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

    public List<EstablishmentDTO> findAll() {
        return establishmentRepository.findAll()
                .stream()
                .map(this::establishmentToDTO)
                .toList();
    }


    public List<ProgramDTO> getProgramsByEstablishment(Integer establishmentId) {

        Establishment est = establishmentRepository.findById(establishmentId)
                .orElseThrow(EstablishmentNotFoundException::new);

        return est.getPrograms()
                .stream()
                .map(programService::toProgramDTO)
                .toList();
    }


    public EstablishmentDTO create(EstablishmentDTO dto) {

        Establishment est = new Establishment();
        est.setName(dto.getName());
        est.setDomainEmail(dto.getDomainEmail());

        Establishment saved = establishmentRepository.save(est);

        return establishmentToDTO(saved);
    }

    public ProgramDTO addProgramToEstablishment(ProgramCreateInEstablishmentDTO dto) {

        Establishment est = establishmentRepository.findById(dto.getEstablishmentId())
                .orElseThrow(EstablishmentNotFoundException::new);

        Program program = new Program();
        program.setName(dto.getName());
        program.setCode(dto.getCode());
        program.setCohort(dto.getCohort());
        program.setColor(dto.getColor());
        program.setEstablishment(est);

        Program saved = programRepository.save(program);

        return programService.toProgramDTO(saved);
    }

    public EstablishmentDTO updateEstablishment(
            Integer establishmentId,
            EstablishmentUpdateDTO dto) {

        Establishment establishment = establishmentRepository.findById(establishmentId)
                .orElseThrow(EstablishmentNotFoundException::new);

        if (dto.getName() != null) {
            establishment.setName(dto.getName());
        }

        if (dto.getDomainEmail() != null) {
            establishment.setDomainEmail(dto.getDomainEmail());
        }

        Establishment saved = establishmentRepository.save(establishment);

        return establishmentToDTO(saved);
    }

    /**
     * Supprime un établissement. La contrainte FK Program.establishment_id ON DELETE CASCADE
     * supprime en base les programmes rattachés (et, en cascade, leurs liens cours/membres) :
     * action DESTRUCTIVE, à confirmer côté front.
     */
    public void deleteEstablishment(Integer establishmentId) {
        Establishment establishment = establishmentRepository.findById(establishmentId)
                .orElseThrow(EstablishmentNotFoundException::new);

        establishmentRepository.delete(establishment);
    }
}