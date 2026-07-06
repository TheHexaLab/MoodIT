package com.moodit.core_service.controller;

import com.moodit.core_service.dto.ChangeRoleRequest;
import com.moodit.core_service.dto.RoleDTO;
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

    @GetMapping
    public ResponseEntity<List<RoleDTO>> getAllRoles() {
        return ResponseEntity.ok(roleService.findAll());
    }

    /** Assigner / retirer un rôle à un membre DANS un programme (User_Program_Role). */
    @PostMapping("/change")
    public ResponseEntity<Void> changeRole(@RequestBody ChangeRoleRequest request) {
        roleService.changeRole(request);
        return ResponseEntity.noContent().build();
    }
}