package com.moodit.core_service.controller;

import com.moodit.core_service.dto.ChangeRoleRequest;
import com.moodit.core_service.dto.RoleDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.service.RoleService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/roles")
@RequiredArgsConstructor
public class RoleController {

    private final RoleService roleService;

    /**
     * Liste les rôles. `scope` optionnel filtre par portée d'attribution :
     * "program" (popup d'un programme) ou "global" (popup des administrateurs).
     */
    @GetMapping
    public ResponseEntity<List<RoleDTO>> getAllRoles(
            @RequestParam(name = "scope", required = false) String scope) {
        return ResponseEntity.ok(roleService.findAll(scope));
    }

    /** Assigner / retirer un rôle à un membre DANS un programme (User_Program_Role). */
    @PostMapping("/change")
    public ResponseEntity<Void> changeRole(@RequestBody ChangeRoleRequest request) {
        roleService.changeRole(request);
        return ResponseEntity.noContent().build();
    }

    /** Administrateurs actuels (utilisateurs ayant un rôle global) — sections du popup admins. */
    @GetMapping("/global/users")
    public ResponseEntity<List<UserDTO>> getGlobalRoleUsers() {
        return ResponseEntity.ok(roleService.getUsersWithGlobalRoles());
    }

    /**
     * Candidats paginés à l'attribution d'un rôle global (utilisateurs n'ayant pas `roleId`),
     * filtrés côté BD par `search`. Alimente le sélecteur d'ajout (infinite scroll + recherche).
     */
    @GetMapping("/global/candidates")
    public ResponseEntity<List<UserDTO>> getGlobalRoleCandidates(
            @RequestParam("roleId") Integer roleId,
            @RequestParam(name = "search", required = false) String search,
            @RequestParam(name = "page", defaultValue = "0") int page,
            @RequestParam(name = "size", defaultValue = "10") int size) {
        return ResponseEntity.ok(roleService.getGlobalRoleCandidates(roleId, search, page, size));
    }

    /** Assigner / retirer un rôle GLOBAL (plateforme) à un utilisateur (User_Role). */
    @PostMapping("/global/change")
    public ResponseEntity<Void> changeGlobalRole(@RequestBody ChangeRoleRequest request) {
        roleService.changeGlobalRole(request);
        return ResponseEntity.noContent().build();
    }
}