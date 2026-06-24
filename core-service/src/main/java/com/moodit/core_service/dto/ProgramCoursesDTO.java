package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class ProgramCoursesDTO extends ProgramDTO{
    private List<CourseDTO> courses;
}
