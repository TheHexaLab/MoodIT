package com.moodit.core_service.service;

import com.moodit.core_service.dto.ChangeRoleRequest;
import com.moodit.core_service.dto.RoleDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.model.RoleNames;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.UserProgramRole;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.RoleDto;
import com.moodit.core_service.repository.RoleRepository;
import com.moodit.core_service.repository.UserProgramRoleRepository;
import com.moodit.core_service.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.PageRequest;
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
    private final UserRepository userRepository;
    private final UserService userService;
    private final RealtimeEventPublisher realtimePublisher;

    public List<RoleDTO> findAll() {
        return findAll(null);
    }

    /**
     * Liste les rôles filtrés par portée d'attribution :
     *   "program" → attribuables dans le popup d'un programme (program_assignable) ;
     *   "global"  → attribuables dans le popup des administrateurs (global_assignable) ;
     *   null/autre → tous.
     */
    public List<RoleDTO> findAll(String scope) {
        return roleRepository.findAll().stream()
                .filter(
                        role ->
                                switch (scope == null ? "" : scope) {
                                    case "program" -> role.isProgramAssignable();
                                    case "global" -> role.isGlobalAssignable();
                                    default -> true;
                                })
                .map(this::toDTO)
                .toList();
    }

    /**
     * Administrateurs actuels : utilisateurs ayant AU MOINS un rôle global (User_Role), avec
     * leurs rôles. Alimente les SECTIONS du popup admins (liste des assignés, petite).
     */
    public List<UserDTO> getUsersWithGlobalRoles() {
        return userRepository.findUsersWithGlobalRole().stream().map(userService::toUserDTO).toList();
    }

    /**
     * Candidats paginés à l'attribution d'un rôle global : utilisateurs n'ayant PAS `roleId`,
     * filtrés par `search` (côté BD). Alimente le SÉLECTEUR d'ajout (infinite scroll + recherche).
     */
    public List<UserDTO> getGlobalRoleCandidates(Integer roleId, String search, int page, int size) {
        String q = search == null ? "" : search.trim().toLowerCase();
        int safeSize = size <= 0 ? 10 : Math.min(size, 50);
        int safePage = Math.max(page, 0);
        return userRepository
                .findGlobalRoleCandidates(roleId, q, PageRequest.of(safePage, safeSize))
                .stream()
                .map(userService::toUserDTO)
                .toList();
    }

    /**
     * Assigne ou retire un rôle GLOBAL (plateforme) à un utilisateur (User_Role). Enforcement
     * FRONT uniquement : le backend ne vérifie PAS les droits de l'appelant (choix assumé), il
     * garde seulement l'intégrité (le rôle doit être global_assignable). Idempotent.
     */
    @Transactional
    public void changeGlobalRole(ChangeRoleRequest req) {
        if (req.getUserId() == null || req.getRoleId() == null) {
            throw new IllegalArgumentException("userId et roleId sont requis");
        }
        User user = userRepository.findById(req.getUserId()).orElseThrow(UserNotFoundException::new);
        Role role =
                roleRepository
                        .findById(req.getRoleId())
                        .orElseThrow(() -> new IllegalArgumentException("Rôle introuvable"));
        if (!role.isGlobalAssignable()) {
            throw new IllegalArgumentException("Ce rôle n'est pas attribuable globalement");
        }

        boolean has = user.getRoles().stream().anyMatch(r -> r.getId().equals(role.getId()));
        if ("assign".equals(req.getType())) {
            if (!has) {
                user.getRoles().add(role);
                userRepository.save(user);
            }
        } else if ("unassign".equals(req.getType())) {
            if (has) {
                user.getRoles().removeIf(r -> r.getId().equals(role.getId()));
                userRepository.save(user);
            }
        } else {
            throw new IllegalArgumentException("Type inconnu : " + req.getType());
        }

        // ── Temps réel (captures DÉTACHÉES avant l'écho after-commit, dans la tx : lazy OK) ──
        //  1. room user:<userId> : l'utilisateur concerné re-dérive ses droits plateforme LIVE ;
        //  2. room adminRoles:0  : les admins/gardiens qui ont le popup ouvert remplacent leur liste.
        // getUsersWithGlobalRoles() tourne dans la tx (flush AUTO → voit le changement qu'on vient
        // de sauver) et renvoie des DTO détachés, sûrs à émettre après commit.
        long userId = req.getUserId();
        List<RoleDto> updatedRoles =
                user.getRoles().stream()
                        .map(r -> new RoleDto(r.getId(), r.getName()))
                        .collect(Collectors.toList());
        List<UserDTO> admins = getUsersWithGlobalRoles();
        afterCommit(
                () -> {
                    realtimePublisher.globalRolesChanged(userId, updatedRoles);
                    realtimePublisher.adminRolesChanged(admins);
                });
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
        if (names.contains(RoleNames.ADMIN)) {
            return RoleNames.ADMIN;
        }
        if (names.contains(RoleNames.TEACHER)) {
            return RoleNames.TEACHER;
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