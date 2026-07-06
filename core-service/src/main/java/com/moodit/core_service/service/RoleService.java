package com.moodit.core_service.service;

import com.moodit.core_service.dto.ChangeRoleRequest;
import com.moodit.core_service.dto.RoleDTO;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.model.UserProgramRole;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.RoleRepository;
import com.moodit.core_service.repository.UserProgramRoleRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class RoleService {

    private final RoleRepository roleRepository;
    private final UserProgramRoleRepository userProgramRoleRepository;
    private final RealtimeEventPublisher realtimePublisher;

    public List<RoleDTO> findAll() {
        return roleRepository.findAll()
                .stream()
                .map(this::toDTO)
                .toList();
    }

    /**
     * Assigne ou retire un rôle à un utilisateur DANS un programme (User_Program_Role).
     * Idempotent à l'assignation (pas de doublon) ; no-op au retrait d'un rôle absent.
     */
    @Transactional
    public void changeRole(ChangeRoleRequest req) {
        if (req.getProgramId() == null || req.getUserId() == null || req.getRoleId() == null) {
            throw new IllegalArgumentException("programId, userId et roleId sont requis");
        }
        if ("assign".equals(req.getType())) {
            if (!userProgramRoleRepository.existsByProgramIdAndUserIdAndRoleId(
                    req.getProgramId(), req.getUserId(), req.getRoleId())) {
                userProgramRoleRepository.save(
                        new UserProgramRole(req.getProgramId(), req.getUserId(), req.getRoleId()));
            }
        } else if ("unassign".equals(req.getType())) {
            userProgramRoleRepository.deleteByProgramIdAndUserIdAndRoleId(
                    req.getProgramId(), req.getUserId(), req.getRoleId());
        } else {
            throw new IllegalArgumentException("Type inconnu : " + req.getType());
        }

        // ── Temps réel : le rôle du membre a changé DANS ce programme → ses menus d'actions
        // administratives se re-calculent LIVE (room user:<userId>). On envoie le rôle le plus
        // élevé RESTANT (après le changement, déjà visible dans la transaction). ──
        long userId = req.getUserId();
        long programId = req.getProgramId();
        String roleName = highestRoleName(req.getProgramId(), req.getUserId());
        afterCommit(() -> realtimePublisher.programRoleChanged(userId, programId, roleName));
    }

    /**
     * Rôle le plus élevé de l'utilisateur DANS un programme (User_Program_Role) :
     * "Administrateur" prime sur "Enseignant" ; null si plus aucun rôle.
     */
    private String highestRoleName(Integer programId, Integer userId) {
        Map<Integer, String> roleNameById =
                roleRepository.findAll().stream()
                        .collect(Collectors.toMap(Role::getId, Role::getName));
        List<String> names =
                userProgramRoleRepository.findByProgramIdAndUserId(programId, userId).stream()
                        .map(upr -> roleNameById.get(upr.getRoleId()))
                        .collect(Collectors.toList());
        if (names.contains("Administrateur")) {
            return "Administrateur";
        }
        if (names.contains("Enseignant")) {
            return "Enseignant";
        }
        return null;
    }

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

    private RoleDTO toDTO(Role role) {
        return RoleDTO.builder()
                .id(role.getId())
                .name(role.getName())
                .build();
    }
}