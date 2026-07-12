package com.moodit.core_service.controller;

import com.moodit.core_service.dto.AuditLogDTO;
import com.moodit.core_service.service.AuditLogService;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Journal d'audit — /api/audit-logs (préfixe /api ajouté par WebMvcConfig). Réservé aux Gardiens :
 * l'autorisation est faite en amont par le permission-service (règle GET /audit-logs → Gardien).
 */
@RestController
@RequestMapping("/audit-logs")
@RequiredArgsConstructor
public class AuditLogController {

    private final AuditLogService auditLogService;

    /**
     * Page d'actions de gestion (les plus récentes d'abord). Pagination par CURSEUR : {@code beforeId}
     * absent = première page, sinon page suivante (entrées d'id inférieur). {@code type} filtre par
     * type d'entité et {@code q} recherche plein-texte — tout est appliqué côté base.
     */
    @GetMapping
    public ResponseEntity<List<AuditLogDTO>> getLogs(
            @RequestParam(name = "limit", defaultValue = "30") int limit,
            @RequestParam(name = "beforeId", required = false) Integer beforeId,
            @RequestParam(name = "type", required = false) String type,
            @RequestParam(name = "q", required = false) String q) {
        return ResponseEntity.ok(auditLogService.search(beforeId, type, q, limit));
    }
}
