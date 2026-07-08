package com.moodit.core_service.dto;

import aQute.bnd.annotation.metatype.Meta;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class ProgramDTO {
    private Integer id;
    private String name;
    private String code;
    private String cohort;
    private String color;
    /**
     * Rôle le plus élevé de l'utilisateur COURANT dans ce programme (User_Program_Role) :
     * "Administrateur", "Enseignant", ou null. Renseigné par fetchPrograms pour piloter les
     * permissions côté front ; null dans les autres contextes.
     */
    private String roleName;
}

