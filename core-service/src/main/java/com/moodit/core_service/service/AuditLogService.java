package com.moodit.core_service.service;

import com.moodit.core_service.dto.AuditLogDTO;
import com.moodit.core_service.model.AuditLog;
import com.moodit.core_service.repository.AuditLogRepository;
import java.time.ZoneOffset;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.PageRequest;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Écrit et lit le journal d'audit des actions de GESTION. {@link #record} s'appelle DANS la
 * transaction de la mutation (le log est donc atomique avec elle : annulé si la mutation échoue).
 * L'auteur est lu du {@code SecurityContext} (email posé par {@code GatewayAuthFilter}) — inutile de
 * threader l'email jusqu'à chaque service.
 */
@Service
@RequiredArgsConstructor
public class AuditLogService {

    private final AuditLogRepository repository;

    /** Nombre maximum d'entrées renvoyées par {@link #getRecent} (borne anti-DoS). */
    private static final int MAX_LIMIT = 500;

    /** Longueur max de {@code summary} (= colonne BD) : on tronque plutôt que de casser la mutation. */
    private static final int SUMMARY_MAX = 512;

    /** Longueur max de {@code details} (= colonne BD). */
    private static final int DETAILS_MAX = 1024;

    /** Sans contexte parent : cf. {@link #record(String, String, Integer, String, String)}. */
    public void record(String action, String entityType, Integer entityId, String summary) {
        record(action, entityType, entityId, summary, null);
    }

    /**
     * Enregistre une action de gestion. {@code entityId}/{@code details} peuvent être null.
     * {@code summary} = phrase FR lisible, prête à afficher (ex. « a supprimé le cours GIF201 ») ;
     * {@code details} = contexte PARENT capturé MAINTENANT (établissement, programmes, cours…), pour
     * survivre à la suppression de l'entité. {@code record} partageant la transaction de la mutation,
     * on TRONQUE aux tailles de colonnes : un nom inhabituellement long ne doit jamais faire échouer
     * l'action métier elle-même.
     */
    public void record(
            String action, String entityType, Integer entityId, String summary, String details) {
        AuditLog log = new AuditLog();
        log.setActorEmail(currentActorEmail());
        log.setAction(action);
        log.setEntityType(entityType);
        log.setEntityId(entityId);
        log.setSummary(truncate(summary, SUMMARY_MAX, ""));
        log.setDetails(truncate(details, DETAILS_MAX, null));
        repository.save(log);
    }

    /** Tronque à {@code max} (avec une ellipse) ; null → {@code fallback}. */
    private static String truncate(String value, int max, String fallback) {
        if (value == null) {
            return fallback;
        }
        if (value.length() <= max) {
            return value;
        }
        return value.substring(0, max - 1) + "…";
    }

    /**
     * Page du journal (la plus récente d'abord). Pagination par CURSEUR ({@code beforeId} null =
     * première page). Recherche plein-texte {@code q} et filtre {@code type} appliqués CÔTÉ BASE.
     */
    @Transactional(readOnly = true)
    public List<AuditLogDTO> search(Integer beforeId, String type, String q, int limit) {
        int capped = Math.max(1, Math.min(limit, MAX_LIMIT));
        String typeFilter = (type == null || type.isBlank()) ? null : type.trim();
        String like = (q == null || q.isBlank()) ? null : "%" + q.trim().toLowerCase() + "%";
        return repository.search(beforeId, typeFilter, like, PageRequest.of(0, capped)).stream()
                .map(AuditLogService::toDTO)
                .toList();
    }

    private static AuditLogDTO toDTO(AuditLog l) {
        return new AuditLogDTO(
                l.getId(),
                l.getCreatedAt() == null ? null : l.getCreatedAt().toInstant(ZoneOffset.UTC),
                l.getActorEmail(),
                l.getAction(),
                l.getEntityType(),
                l.getEntityId(),
                l.getSummary(),
                l.getDetails());
    }

    /** Email de l'auteur courant (ou null) — exposé aux services qui doivent résoudre l'acteur. */
    public String currentActor() {
        return currentActorEmail();
    }

    /** Email de l'auteur courant (posé par le gateway dans le SecurityContext), ou null. */
    private static String currentActorEmail() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        Object principal = auth == null ? null : auth.getPrincipal();
        return principal == null ? null : principal.toString();
    }
}
