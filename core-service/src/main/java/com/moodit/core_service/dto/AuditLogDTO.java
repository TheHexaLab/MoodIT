package com.moodit.core_service.dto;

import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/** Une entrée du journal d'audit exposée au front (Gardien uniquement). */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class AuditLogDTO {
    private Integer id;
    private Instant createdAt;
    private String actorEmail;
    private String action;
    private String entityType;
    private Integer entityId;
    private String summary;
    private String details;
}
