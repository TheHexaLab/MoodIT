package com.moodit.mcp_service.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Détail complet d'une analyse MCP (chargé au clic sur une entrée de l'historique).
 * Miroir du type front `McpResponse` : `content` = JSON McpAnalysis, `author` = l'auteur.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record McpResponseDto(
        long id,
        String createdAt,
        String content,
        long userId,
        long courseId,
        Author author) {}
