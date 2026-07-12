package com.moodit.core_service.repository;

import com.moodit.core_service.model.AuditLog;
import java.util.List;

/**
 * Recherche paginée du journal, construite DYNAMIQUEMENT (Criteria). Chaque filtre présent devient
 * un prédicat INCONDITIONNEL (sargable) — contrairement à un « {@code :param IS NULL OR col …} »
 * qui pousse Postgres vers un plan générique en seq scan et neutralise les index GIN trigram.
 */
public interface AuditLogRepositoryCustom {

    /**
     * Page (id DESC). {@code beforeId} null = 1re page, sinon curseur (id &lt; beforeId).
     * {@code type} = entity_type exact (ou null). {@code like} = motif déjà en {@code %minuscule%}
     * (ou null) recherché sur lower(summary|actor_email|details).
     */
    List<AuditLog> search(Integer beforeId, String type, String like, int limit);
}
