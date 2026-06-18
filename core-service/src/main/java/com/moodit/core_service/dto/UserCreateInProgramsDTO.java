package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class UserCreateInProgramsDTO extends UserDTO{
    private List<Integer> programIds;
}
