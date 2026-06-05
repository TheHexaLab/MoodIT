package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class CourseCreateDTO extends CourseDTO{
    private List<Integer> programIds;
}
