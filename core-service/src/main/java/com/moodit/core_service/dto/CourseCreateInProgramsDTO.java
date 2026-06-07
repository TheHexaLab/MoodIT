package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class CourseCreateInProgramsDTO extends CourseDTO{
    private List<Integer> programIds;
}
