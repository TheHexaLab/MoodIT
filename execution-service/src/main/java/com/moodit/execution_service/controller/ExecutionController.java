package com.moodit.execution_service.controller;

import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.security.GatewayAuthFilter;
import com.moodit.execution_service.service.ExecutionLimiter;
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
 * Exécution de code (questions Code). Servi sous /exec (le gateway route /exec/** ici). Réservé
 * aux utilisateurs authentifiés (cf. SecurityConfig). Slice actuel : « Tester » synchrone, sans
 * persistance — la correction async des soumissions (WS + Submission_Test_Case) viendra ensuite.
 * Chaque requête compte dans la limite PAR UTILISATEUR (#24) : l'identité est le
 * {@code X-User-Email} posé par le gateway (cf. {@link GatewayAuthFilter}).
 */
@RestController
@RequestMapping("/exec")
public class ExecutionController {

    private final ExecutionService executionService;
    private final ExecutionLimiter limiter;

    public ExecutionController(ExecutionService executionService, ExecutionLimiter limiter) {
        this.executionService = executionService;
        this.limiter = limiter;
    }

    /** Exécute le code fourni contre chaque harnais et renvoie le verdict par test. */
    @PostMapping("/evaluate")
    public ResponseEntity<List<TestResult>> evaluate(
            @RequestHeader(value = GatewayAuthFilter.USER_EMAIL_HEADER, required = false) String user,
            @Valid @RequestBody EvaluateRequest request) {
        return ResponseEntity.ok(limiter.forUser(user, () -> executionService.evaluate(request)));
    }

    /** Exécute le code TEL QUEL (sans harnais) et renvoie sa sortie brute (bouton « play »). */
    @PostMapping("/run")
    public ResponseEntity<RunResult> run(
            @RequestHeader(value = GatewayAuthFilter.USER_EMAIL_HEADER, required = false) String user,
            @Valid @RequestBody RunRequest request) {
        return ResponseEntity.ok(limiter.forUser(user, () -> executionService.run(request)));
    }
}
