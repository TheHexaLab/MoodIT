package com.moodit.mcp_service.model;

import jakarta.persistence.*;
import lombok.Data;

/** Vue slim d'un rôle (table role). Sert au contrôle « Administrateur ». Lecture seule. */
@Entity
@Data
@Table(name = "role")
public class Role {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, unique = true, length = 128)
    private String name;
}
