package com.moodit.core_service.model;
import jakarta.persistence.*;
import lombok.Data;

import java.util.List;

@Entity
@Data
@Table(name = "role")
public class Role {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, unique = true, length = 128)
    private String name;

    /** Attribuable dans le popup « Gérer les rôles » d'un programme (User_Program_Role). */
    @Column(name = "program_assignable", nullable = false)
    private boolean programAssignable = true;

    /** Attribuable dans le popup de gestion des administrateurs (User_Role, plateforme). */
    @Column(name = "global_assignable", nullable = false)
    private boolean globalAssignable = false;

    @ManyToMany(mappedBy = "roles")
    private List<User> users;
}