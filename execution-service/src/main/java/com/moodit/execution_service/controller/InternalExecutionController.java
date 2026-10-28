package com.moodit.execution_service.controller;

import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.security.InternalTokenValidator;
import com.moodit.execution_service.service.ExecutionService;

import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Endpoint INTERNE (service à service) : correction des questions Code d'une soumission, appelé
 * par core-service. Hors gateway (jamais routé) et authentifié par un jeton partagé
 * {@code X-Internal-Token} (= {@code app.internal.token}). Même logique que le « Tester » public,
 * sans l'auth utilisateur du gateway.
 */
@RestController
@RequestMapping("/internal/exec")
public class InternalExecutionController {

    private final ExecutionService executionService;
    private final InternalTokenValidator tokenValidator;

    public InternalExecutionController(
            ExecutionService executionService, InternalTokenValidator tokenValidator) {
        this.executionService = executionService;
        this.tokenValidator = tokenValidator;
    }

    @PostMapping("/evaluate")
    public ResponseEntity<List<TestResult>> evaluate(
            @RequestHeader(value = "X-Internal-Token", required = false) String token,
            @Valid @RequestBody EvaluateRequest request) {
        if (unauthorized(token)) return ResponseEntity.status(403).build();
        return ResponseEntity.ok(executionService.evaluate(request));
    }

    private boolean unauthorized(String token) {
        return !tokenValidator.isValid(token);
    }
}
