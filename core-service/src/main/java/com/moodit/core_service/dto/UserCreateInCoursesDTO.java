package com.moodit.core_service.dto;

import lombok.Data;

import java.util.List;

@Data
public class UserCreateInCoursesDTO {
    private Integer id;
    private List<Integer> courseIds;
    /**
     * Programme concerné : limite la SYNCHRO aux cours de ce programme (déselection =
     * désinscription). Null → portée globale (rétrocompat).
     */
    private Integer programId;
}
