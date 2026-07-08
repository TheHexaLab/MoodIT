package com.moodit.core_service.controller;

import com.moodit.core_service.dto.LanguageDTO;
import com.moodit.core_service.service.QuizService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/languages") // /api/languages
@RequiredArgsConstructor
public class LanguageController {

    private final QuizService quizService;

    /** Langages d'exécution disponibles (table Language) pour le sélecteur de l'éditeur de code. */
    @GetMapping
    public ResponseEntity<List<LanguageDTO>> getLanguages() {
        return ResponseEntity.ok(quizService.getLanguages());
    }
}
