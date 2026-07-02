package com.moodit.mcp_service.dto;

/**
 * Auteur d'une analyse (l'utilisateur qui l'a déclenchée), tel qu'affiché dans le détail.
 * Miroir du type homonyme côté core-service / front.
 */
public record Author(
        long id,
        String username,
        String firstName,
        String lastName,
        String avatarColor) {}
