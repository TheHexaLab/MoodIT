package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.EstablishmentNotFoundException;
import com.moodit.core_service.model.Establishment;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.EstablishmentRepository;
import com.moodit.core_service.repository.ProgramRepository;
import com.moodit.core_service.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class EstablishmentService {

    private final EstablishmentRepository establishmentRepository;
    private final ProgramService programService;
    private final ProgramRepository programRepository;
    private final UserRepository userRepository;
    private final RealtimeEventPublisher realtimePublisher;
    private final AuditLogService auditLogService;

    /** Exécute l'action après le commit (ou tout de suite hors transaction). */
    private void afterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(
                    new TransactionSynchronization() {
                        @Override
                        public void afterCommit() {
                            action.run();
                        }
                    });
        } else {
            action.run();
        }
    }

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


    @Transactional
    public EstablishmentDTO create(EstablishmentDTO dto) {

        Establishment est = new Establishment();
        est.setName(dto.getName());
        est.setDomainEmail(dto.getDomainEmail());

        Establishment saved = establishmentRepository.save(est);

        auditLogService.record("ESTABLISHMENT_CREATE", "ESTABLISHMENT", saved.getId(),
                "Établissement « " + saved.getName() + " » créé");

        // ── Temps réel (GLOBAL) : le nouvel établissement apparaît LIVE dans le popup. Émis APRÈS
        // le commit (afterCommit) pour ne pas diffuser un état non persisté. ──
        long id = saved.getId();
        String name = saved.getName();
        String domainEmail = saved.getDomainEmail();
        afterCommit(() -> realtimePublisher.establishmentUpserted(id, name, domainEmail, 0, List.of()));

        return establishmentToDTO(saved);
    }

    @Transactional
    public ProgramDTO addProgramToEstablishment(ProgramCreateInEstablishmentDTO dto) {

        Establishment est = establishmentRepository.findById(dto.getEstablishmentId())
                .orElseThrow(EstablishmentNotFoundException::new);

        Program program = new Program();
        program.setName(dto.getName());
        program.setCode(dto.getCode());
        program.setCohort(dto.getCohort());
        program.setColor(dto.getColor());
        program.setEstablishment(est);

        Program saved = programRepository.saveAndFlush(program); // flush : catalogue à jour

        auditLogService.record("PROGRAM_CREATE", "PROGRAM", saved.getId(),
                "Programme « " + saved.getName() + " » créé",
                "Établissement : " + est.getName());

        // ── Temps réel (GLOBAL) : le catalogue de l'établissement change → le popup « Ajouter un
        // programme » met à jour la liste des programmes LIVE (nombre, codes, liste détaillée). ──
        programService.publishEstablishmentCatalog(dto.getEstablishmentId());

        return programService.toProgramDTO(saved);
    }

    @Transactional
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

        auditLogService.record("ESTABLISHMENT_UPDATE", "ESTABLISHMENT", establishmentId,
                "Établissement « " + saved.getName() + " » mis à jour");

        EstablishmentDTO result = establishmentToDTO(saved);

        // ── Temps réel (GLOBAL) : nom/domaine mis à jour LIVE dans le popup (par id). Émis APRÈS
        // le commit (afterCommit). ──
        afterCommit(() ->
                realtimePublisher.establishmentUpserted(
                        result.getId(),
                        result.getName(),
                        result.getDomainEmail(),
                        result.getProgramCount(),
                        result.getProgramCodes()));

        return result;
    }

    /**
     * Supprime un établissement. La contrainte FK Program.establishment_id ON DELETE CASCADE
     * supprime en base les programmes rattachés (et, en cascade, leurs liens cours/membres) :
     * action DESTRUCTIVE, à confirmer côté front.
     *
     * ── Temps réel : chaque programme supprimé disparaît LIVE des abonnés (room user:&lt;id&gt;),
     * comme une suppression de programme classique. On capture les couples (abonné, programme)
     * AVANT le delete (les collections lazy sont vidées ensuite), puis on émet après le commit.
     */
    @Transactional
    public void deleteEstablishment(Integer establishmentId) {
        Establishment establishment = establishmentRepository.findById(establishmentId)
                .orElseThrow(EstablishmentNotFoundException::new);

        // (abonné, programme) capturés AVANT la suppression (cascade BD). On récupère les ids des
        // programmes par PROJECTION (pas d'entités Program managées) et on n'initialise PAS la
        // collection lazy de l'établissement : Hibernate ne touche donc pas aux programmes, la
        // suppression reposant uniquement sur ON DELETE CASCADE côté BD.
        List<Map.Entry<Integer, Integer>> deletions = new ArrayList<>();
        for (Integer programId : programRepository.findProgramIdsByEstablishmentId(establishmentId)) {
            userRepository.findDistinctByPrograms_Id(programId).stream()
                    .map(User::getId)
                    .forEach(uid -> deletions.add(Map.entry(uid, programId)));
        }

        String deletedName = establishment.getName();
        establishmentRepository.delete(establishment);

        auditLogService.record("ESTABLISHMENT_DELETE", "ESTABLISHMENT", establishmentId,
                "Établissement « " + deletedName + " » supprimé (#" + establishmentId + ")");

        long estId = establishmentId;
        // Écho WS NON-BLOQUANT : un échec de diffusion ne doit jamais faire échouer la suppression
        // (déjà commitée). programDeleted → abonnés ; establishmentDeleted → popup (retrait LIVE).
        afterCommit(() -> {
            try {
                deletions.forEach(d -> realtimePublisher.programDeleted(d.getKey(), d.getValue()));
                realtimePublisher.establishmentDeleted(estId);
            } catch (RuntimeException ignored) {
                // Best-effort : la suppression a réussi, on ignore une erreur de diffusion.
            }
        });
    }
}