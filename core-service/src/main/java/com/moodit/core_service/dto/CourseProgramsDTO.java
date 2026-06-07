package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class CourseProgramsDTO extends CourseDTO {
    private List<ProgramDTO> programs;
}
