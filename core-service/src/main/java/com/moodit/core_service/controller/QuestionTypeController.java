package com.moodit.core_service.controller;

import com.moodit.core_service.dto.QuestionTypeDTO;
import com.moodit.core_service.service.QuizService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/question-types") // /api/question-types
@RequiredArgsConstructor
public class QuestionTypeController {

    private final QuizService quizService;

    /** Types de question disponibles (table Q_Type) pour l'éditeur de question. */
    @GetMapping
    public ResponseEntity<List<QuestionTypeDTO>> getQuestionTypes() {
        return ResponseEntity.ok(quizService.getQuestionTypes());
    }
}
