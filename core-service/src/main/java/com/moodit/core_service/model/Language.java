package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

/**
 * Langage d'exécution d'une question Code (table language). `name` unique ; les templates
 * (harnais / code de départ) alimentent l'éditeur enseignant. `harnessLanguageId` = langage
 * dans lequel sont écrits les harnais (auto-référence ; null = même langage que la question).
 * Mappé en simple id (pas de relation) pour rester léger côté API.
 */
@Entity
@Data
@Table(name = "language")
public class Language {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, unique = true, length = 64)
    private String name;

    @Column(name = "harness_template", columnDefinition = "TEXT")
    private String harnessTemplate;

    @Column(name = "start_code_template", columnDefinition = "TEXT")
    private String startCodeTemplate;

    @Column(name = "harness_language_id")
    private Integer harnessLanguageId;
}
