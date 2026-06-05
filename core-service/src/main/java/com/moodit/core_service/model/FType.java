package com.moodit.core_service.model;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Data
@Table(name = "f_type")
public class FType {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, unique = true, length = 256)
    private String name;
}