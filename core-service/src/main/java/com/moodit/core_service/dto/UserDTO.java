package com.moodit.core_service.dto;

import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Role;

import java.time.LocalDateTime;
import java.util.List;

import lombok.Data;

@Data
public class UserDTO {
    private Integer id;
    private String username;
    private String firstName;
    private String lastName;
    private String email;
    private String settings;
    private String avatarColor;
    //private String activeTokenHash;
    //private String passwordHash;
    private LocalDateTime createdAt;
    private Boolean verifiedEmail;
    //private List<Role> roles;
}

