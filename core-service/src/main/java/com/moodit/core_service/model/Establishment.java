package com.moodit.core_service.model;
import jakarta.persistence.*;

import java.util.List;

@Entity
@Table(name = "establishment")
public class Establishment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(name = "domain_email", nullable = false, unique = true, length = 256)
    private String domainEmail;

    @OneToMany(mappedBy = "establishment")
    private List<Program> programs;
}