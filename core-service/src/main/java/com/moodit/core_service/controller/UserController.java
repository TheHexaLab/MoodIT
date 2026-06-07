package com.moodit.core_service.controller;

//Model
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.dto.UserProgramsDTO;
import com.moodit.core_service.model.User;

//Service
import com.moodit.core_service.service.UserService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/users")
@RequiredArgsConstructor

public class UserController {

    private final UserService userService;

    @GetMapping("/{userId}")
    public ResponseEntity<UserProgramsDTO> findById(@PathVariable Integer userId) {
        return ResponseEntity.ok(userService.findById(userId));
    }

    @GetMapping("/username/{username}")
    public ResponseEntity<UserProgramsDTO> findByUsername(@PathVariable String username) {
        return ResponseEntity.ok(userService.findByUsername(username));
    }

    @GetMapping("/role/{role}/programs/{programId}")
    public ResponseEntity<List<UserDTO>> findByRole(@PathVariable Integer role, @PathVariable Integer programId) {
        return ResponseEntity.ok(userService.findUsersByProgramAndRole(programId, role));
    }

    @GetMapping("/{userId}/programs")
    public ResponseEntity<List<ProgramDTO>> getProgramsByUser(
            @PathVariable Integer userId) {

        return ResponseEntity.ok(
                userService.findProgramsByUserId(userId)
        );
    }
}
