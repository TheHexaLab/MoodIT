package com.moodit.mcp_service.model;

import jakarta.persistence.*;
import lombok.Data;

/** Vue slim du cours analysé (table course, partagée avec core-service). Lecture seule. */
@Entity
@Data
@Table(name = "course")
public class Course {

    @Id
    @Column(name = "id")
    private Integer id;

    @Column(length = 128)
    private String title;

    @Column(nullable = false, length = 128)
    private String code;
}
