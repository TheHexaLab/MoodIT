package com.moodit.mcp_service.controller;

import com.moodit.mcp_service.dto.McpResponseDto;
import com.moodit.mcp_service.dto.McpResponseSummaryDto;
import com.moodit.mcp_service.service.McpService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Feedback MCP d'un cours (analyse LLM). Servi sous /mcp (le gateway route /mcp/** vers ce
 * service, sans stripping). L'autorisation PAR RÔLE est assurée en amont par le permission-service
 * (règles /mcp/**) ; `X-User-Email` (injecté par le gateway) ne sert plus qu'à scoper les analyses
 * de l'utilisateur courant (isPending / requestAnalysis).
 */
@RestController
@RequestMapping("/mcp")
@RequiredArgsConstructor
public class McpController {

    private final McpService mcpService;

    /** Historique (résumés) des analyses terminées d'un cours, récent → ancien. */
    @GetMapping("/courses/{courseId}/analyses")
    public ResponseEntity<List<McpResponseSummaryDto>> listAnalyses(@PathVariable Integer courseId) {
        return ResponseEntity.ok(mcpService.listAnalyses(courseId));
    }

    /** Détail complet d'une analyse (content + author), chargé au clic. */
    @GetMapping("/analyses/{id}")
    public ResponseEntity<McpResponseDto> getAnalysis(@PathVariable Integer id) {
        return ResponseEntity.ok(mcpService.getAnalysis(id));
    }

    /** L'utilisateur courant a-t-il une analyse en cours pour ce cours ? (réhydratation) */
    @GetMapping("/courses/{courseId}/pending")
    public ResponseEntity<Boolean> isPending(
            @PathVariable Integer courseId,
            @RequestHeader("X-User-Email") String email) {
        return ResponseEntity.ok(mcpService.isPending(courseId, email));
    }

    /**
     * Déclenche une analyse. ASYNCHRONE : répond 202 (job accepté) SANS corps ; le résultat
     * arrive ensuite par WebSocket (mcp:analysis-created / mcp:analysis-failed). 409 si une
     * analyse est déjà en cours pour ce (cours, utilisateur).
     */
    @PostMapping("/courses/{courseId}/analyses")
    public ResponseEntity<Void> requestAnalysis(
            @PathVariable Integer courseId,
            @RequestHeader("X-User-Email") String email) {
        mcpService.requestAnalysis(courseId, email);
        return ResponseEntity.accepted().build();
    }
}
