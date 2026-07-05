package com.moodit.execution_service.controller;

import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.service.ExecutionService;

import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Exécution de code (questions Code). Servi sous /exec (le gateway route /exec/** ici). Réservé
 * aux utilisateurs authentifiés (cf. SecurityConfig). Slice actuel : « Tester » synchrone, sans
 * persistance — la correction async des soumissions (WS + Submission_Test_Case) viendra ensuite.
 */
@RestController
@RequestMapping("/exec")
public class ExecutionController {

    private final ExecutionService executionService;

    public ExecutionController(ExecutionService executionService) {
        this.executionService = executionService;
    }

    /** Exécute le code fourni contre chaque harnais et renvoie le verdict par test. */
    @PostMapping("/evaluate")
    public ResponseEntity<List<TestResult>> evaluate(@Valid @RequestBody EvaluateRequest request) {
        return ResponseEntity.ok(executionService.evaluate(request));
    }

    /** Exécute le code TEL QUEL (sans harnais) et renvoie sa sortie brute (bouton « play »). */
    @PostMapping("/run")
    public ResponseEntity<RunResult> run(@Valid @RequestBody RunRequest request) {
        return ResponseEntity.ok(executionService.run(request));
    }
}
