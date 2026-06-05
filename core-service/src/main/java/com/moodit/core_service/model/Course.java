package com.moodit.core_service.model;
import jakarta.persistence.*;
import lombok.Data;

import java.util.List;

@Entity
@Data
@Table(name = "course")
public class Course {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id")
    private Integer id;

    @Column(length = 128)
    private String title;

    @Column(length = 256)
    private String description;

    @Column(nullable = false, length = 128)
    private String code;

    @ManyToMany(mappedBy = "courses")
    private List<Program> programs;

}