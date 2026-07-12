package com.moodit.core_service.repository;

import com.moodit.core_service.model.AuditLog;
import java.util.List;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface AuditLogRepository extends JpaRepository<AuditLog, Integer> {

    /**
     * Page du journal, la plus récente d'abord (id DESC = ordre stable et append-only). Pagination
     * par CURSEUR : {@code beforeId} null = première page, sinon on renvoie les entrées d'id
     * strictement inférieur (page suivante en scroll). Filtres optionnels : {@code type}
     * (entity_type exact) et {@code like} (déjà en {@code %minuscule%}) recherché sur summary,
     * auteur, action, type et details. La taille de page vient du {@code Pageable}.
     */
    @Query(
            """
            SELECT a FROM AuditLog a
            WHERE (:beforeId IS NULL OR a.id < :beforeId)
              AND (:type IS NULL OR a.entityType = :type)
              AND (:like IS NULL
                   OR lower(a.summary) LIKE :like
                   OR lower(a.actorEmail) LIKE :like
                   OR lower(a.action) LIKE :like
                   OR lower(a.entityType) LIKE :like
                   OR lower(a.details) LIKE :like)
            ORDER BY a.id DESC
            """)
    List<AuditLog> search(
            @Param("beforeId") Integer beforeId,
            @Param("type") String type,
            @Param("like") String like,
            Pageable pageable);
}
