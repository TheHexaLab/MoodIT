package com.moodit.core_service.dto;

import lombok.*;
import lombok.experimental.SuperBuilder;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class ProgramUpdateDTO {
    private String name;
    private String code;
    private String cohort;
    private String color;
}
