package com.moodit.core_service.model;
import jakarta.persistence.*;

@Entity
@Table(name = "Program")
public class Program {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, length = 128)
    private String name;
    @Column(nullable = false, length = 128)
    private String code;
    @Column(nullable = false, length = 128)
    private String cohort;
    @Column(nullable = false, length = 9)
    private String color = "#0a5cc0";

    //@ManyToOne(fetch = FetchType.LAZY)
    //@JoinColumn(name = "establishment_id", nullable = false)
    //private Establishment establishment;
}