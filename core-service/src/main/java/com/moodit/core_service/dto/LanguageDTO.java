package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Langage d'exécution (table language). Renvoyé COMPLET par GET /api/languages (sélecteur de
 * l'éditeur : templates inclus) et, en version LIGHT (id + name seulement), imbriqué dans une
 * question Code de passation — on ne divulgue pas les templates de harnais aux étudiants.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class LanguageDTO {
    private Integer id;
    private String name;
    private String harnessTemplate;
    private String startCodeTemplate;
    private Integer harnessLanguageId;
}
