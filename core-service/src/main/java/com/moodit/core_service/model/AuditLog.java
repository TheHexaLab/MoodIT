package com.moodit.core_service.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Data;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.SourceType;

/**
 * Une entrée du journal d'audit : une action de GESTION horodatée (rôle, établissement, programme,
 * cours, forum, quiz, analyse MCP). {@code actorEmail} est un instantané (pas de FK) pour survivre à
 * la suppression de l'auteur ; {@code summary} est une phrase lisible construite au moment de l'action.
 */
@Entity
@Data
@Table(name = "audit_log")
public class AuditLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @CreationTimestamp(source = SourceType.DB)
    @Column(name = "created_at", updatable = false)
    private LocalDateTime createdAt;

    @Column(name = "actor_email", length = 256)
    private String actorEmail;

    @Column(name = "action", nullable = false, length = 48)
    private String action;

    @Column(name = "entity_type", nullable = false, length = 24)
    private String entityType;

    @Column(name = "entity_id")
    private Integer entityId;

    @Column(name = "summary", nullable = false, length = 512)
    private String summary;

    /** Contexte PARENT capturé au moment de l'action (établissement, programmes, cours…). Peut être null. */
    @Column(name = "details", length = 1024)
    private String details;
}
