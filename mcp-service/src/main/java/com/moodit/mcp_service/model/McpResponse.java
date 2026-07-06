package com.moodit.mcp_service.model;

import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.SourceType;

import java.time.LocalDateTime;

/**
 * Feedback généré par le service MCP sur un COURS (table mcp_response, partagée avec
 * core-service). Une ligne par analyse ; `user` = celui qui l'a déclenchée (verrou
 * « en cours » par (cours, user), via l'index unique partiel de init.sql). `content`
 * porte le JSON {@link com.moodit.mcp_service.dto.McpAnalysis} — null tant que PENDING/FAILED.
 */
@Entity
@Data
@Table(name = "mcp_response")
public class McpResponse {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    /** Horodatage généré par la BASE (DEFAULT NOW()), même horloge que les autres tables. */
    @CreationTimestamp(source = SourceType.DB)
    @Column(name = "created_at", updatable = false)
    private LocalDateTime createdAt;

    /** JSON de l'analyse (McpAnalysis). Null en PENDING / FAILED. */
    @Column(columnDefinition = "TEXT")
    private String content;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private McpStatus status;

    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "course_id", nullable = false)
    private Course course;
}
