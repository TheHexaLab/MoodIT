package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class UserProgramsDTO extends UserDTO{
    private List<ProgramDTO> programs;
}
