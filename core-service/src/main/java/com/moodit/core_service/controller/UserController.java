package com.moodit.core_service.controller;

//Model
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.model.User;

//Service
import com.moodit.core_service.service.UserService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/users")
@RequiredArgsConstructor

public class UserController {

    private final UserService userService;

    @GetMapping
    public ResponseEntity<List<UserDTO>> findAll() { return ResponseEntity.ok(userService.findAll());}
}
