package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class EstablishmentProgramsDTO {
    private Integer id;
    private String name;
    private String domainEmail;
    private List<ProgramDTO> programs;
}
