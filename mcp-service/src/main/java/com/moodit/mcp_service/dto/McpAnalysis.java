package com.moodit.mcp_service.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * Analyse MCP structurée : forme produite par le LLM, sérialisée dans McpResponse.content
 * (JSON), miroir exact du type front `McpAnalysis` (frontend/src/types/domain.ts).
 *
 * <p>Enrichie : au-delà du score global, elle porte une {@code summary} narrative, des
 * {@code dimensions} (sous-scores par axe), des {@code strengths}/{@code improvements} et des
 * {@code recommendations} actionnables. {@code sources} = compteurs RÉELS réinjectés par le
 * backend (jamais du LLM). {@code @JsonIgnoreProperties(ignoreUnknown)} : tolère d'anciennes
 * analyses sans les nouveaux champs.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record McpAnalysis(
        int score,
        String summary,
        Dimensions dimensions,
        List<String> strengths,
        List<String> improvements,
        List<String> recommendations,
        Sources sources) {

    /**
     * Sous-scores 0-100 par dimension. {@code content}/{@code engagement} sont toujours
     * mesurables (0 = néant, pas d'inconnue). {@code success}/{@code sentiment} valent
     * {@code null} = N/D quand la donnée sous-jacente est absente (aucune note/code, aucun
     * message) — on n'affiche PAS un 50 trompeur. Décidé côté backend, jamais par le LLM.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Dimensions(
            int content,          // richesse du contenu / offre de quiz
            int engagement,       // activité des forums + participation aux quiz
            Integer success,      // réussite (quiz/code) ; null = N/D (aucune donnée)
            Integer sentiment) {} // ressenti (messages) ; null = N/D (aucun message)

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Sources(
            int quizCount,
            int forumMessageCount,
            int studentCount) {}
}
