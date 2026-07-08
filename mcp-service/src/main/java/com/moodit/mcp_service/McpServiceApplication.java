package com.moodit.mcp_service;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Microservice MCP : analyse de la « santé » d'un cours via un LLM (client compatible
 * OpenAI, Ollama en local par défaut) avec repli déterministe. Extrait de core-service ;
 * partage la même base PostgreSQL et pousse ses résultats par le WebSocket de core-service
 * (endpoint interne). Servi sous /mcp (le gateway route /mcp/** ici, port 8082).
 */
@SpringBootApplication
public class McpServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(McpServiceApplication.class, args);
    }
}
