package com.moodit.core_service.dto;

import com.moodit.core_service.model.Program;
import lombok.Data;

@Data
public class ProgramCreateInEstablishmentDTO extends ProgramDTO {

    private Integer establishmentId;
}
