package com.moodit.mcp_service.model;

import jakarta.persistence.*;
import lombok.Data;

import java.util.List;

/**
 * Vue slim de l'utilisateur (table user_, partagée avec core-service). On ne charge que
 * ce dont MCP a besoin : identité (auteur d'une analyse) et rôles (contrôle admin).
 * Lecture seule — mcp-service n'écrit jamais cette table.
 */
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

    @Column(name = "avatar_color", length = 9)
    private String avatarColor;

    @ManyToMany(fetch = FetchType.EAGER)
    @JoinTable(
            name = "user_role",
            joinColumns = @JoinColumn(name = "user_id"),
            inverseJoinColumns = @JoinColumn(name = "role_id"))
    private List<Role> roles;
}
