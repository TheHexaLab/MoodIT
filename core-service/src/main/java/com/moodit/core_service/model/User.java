package com.moodit.core_service.model;
import jakarta.persistence.*;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.List;

@Entity
@Data
@Table(name = "user_")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, unique = true, length = 64)
    private String username;

    @Column(name = "first_name", nullable = false)
    private String firstName;

    @Column(name = "last_name", nullable = false)
    private String lastName;

    @Column(nullable = false, unique = true, length = 256)
    private String email;

    @Column(columnDefinition = "TEXT")
    private String settings;

    @Column(name = "avatar_color", length = 9)
    private String avatarColor = "#0a5cc0";

    @Column(name = "active_token_hash", length = 256)
    private String activeTokenHash;

    @Column(name = "password_hash", nullable = false, length = 256)
    private String passwordHash;

    @Column(name = "created_at")
    private LocalDateTime createdAt;

    /*@Column(name = "verified_email")
    private Boolean verifiedEmail;*/

    @ManyToMany
    @JoinTable(
            name = "user_role",
            joinColumns = @JoinColumn(name = "user_id"),
            inverseJoinColumns = @JoinColumn(name = "role_id")
    )
    private List<Role> roles;

    @ManyToMany
    @JoinTable(
            name = "user_program",
            joinColumns = @JoinColumn(name = "user_id"),
            inverseJoinColumns = @JoinColumn(name = "program_id")
    )
    private List<Program> programs;
}