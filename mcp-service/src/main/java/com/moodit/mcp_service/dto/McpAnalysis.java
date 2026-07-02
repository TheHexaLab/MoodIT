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

    /** Sous-scores 0-100 par dimension d'analyse. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Dimensions(
            int content,      // richesse du contenu / offre de quiz
            int engagement,   // activité des forums + participation aux quiz
            int success,      // réussite (tests de code)
            int sentiment) {} // ressenti des étudiants (déduit des messages)

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Sources(
            int quizCount,
            int forumMessageCount,
            int studentCount) {}
}
