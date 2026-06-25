package com.moodit.core_service.dto;

import com.moodit.core_service.model.Program;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class ProgramCreateInEstablishmentDTO extends ProgramDTO {

    private Integer establishmentId;
}
