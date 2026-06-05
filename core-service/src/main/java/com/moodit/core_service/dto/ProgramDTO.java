package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class ProgramDTO {
    private Integer id;
    private String name;
    private String code;
    private String cohort;
    private String color;
    //private EstablishmentDTO establishment;
    private List<CourseDTO> courses;
}
