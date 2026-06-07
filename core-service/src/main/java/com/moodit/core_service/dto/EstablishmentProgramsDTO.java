package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class EstablishmentProgramsDTO {
    private Integer id;
    private String name;
    private String domainEmail;
    private List<ProgramDTO> programs;
}
