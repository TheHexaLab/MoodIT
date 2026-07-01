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
public class UserCreateInProgramsDTO extends UserDTO{
    private List<Integer> programIds;
    /**
     * Établissement concerné : limite la SYNCHRO aux programmes de cet établissement
     * (déselection = désabonnement). Null → ajout seul (rétrocompat, ex. création).
     */
    private Integer establishmentId;
}
