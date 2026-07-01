package com.moodit.core_service.dto;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class EstablishmentDTO {
    private Integer id;
    private String name;
    private String domainEmail;
    /** Nombre de programmes de l'établissement (catalogue d'adhésion). */
    private Integer programCount;
}
