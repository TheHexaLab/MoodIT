package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class UserCreateInCoursesDTO {
    private Integer id;
    private List<Integer> courseIds;
}
