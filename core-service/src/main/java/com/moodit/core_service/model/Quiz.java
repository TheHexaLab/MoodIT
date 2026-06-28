package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table(name = "quiz")
public class Quiz {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, length = 128)
    private String title;

    @Column(name = "is_daily", nullable = false)
    private Boolean isDaily;

    @Column(name = "is_published", nullable = false)
    private Boolean isPublished;

    /** Ordre d'affichage dans la section Quiz du cours (cf. init.sql Quiz.position). */
    @Column(nullable = false)
    private Integer position;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    @ManyToOne
    @JoinColumn(name = "course_id", nullable = false)
    private Course course;
}
