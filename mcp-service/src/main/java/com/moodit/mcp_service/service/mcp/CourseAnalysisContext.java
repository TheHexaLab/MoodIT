package com.moodit.mcp_service.service.mcp;

import java.util.List;

/**
 * Contexte factuel d'un cours passé au LLM. Données RÉELLES agrégées en base (pas
 * d'hallucination) :
 * <ul>
 *   <li>compteurs quiz / messages / étudiants (santé globale) ;</li>
 *   <li>{@code forumSamples} : un échantillon du CONTENU des messages → permet au LLM de
 *       juger le RESSENTI (ce que les étudiants ont apprécié ou moins) ;</li>
 *   <li>participation aux quiz ({@code quizAttempts}, {@code quizStudents}) et
 *       {@code codeTestPassRate} : % de cas de test réussis aux questions de code (seul
 *       résultat réellement stocké en base) → réussite. {@code null} si aucun test soumis.</li>
 * </ul>
 */
public record CourseAnalysisContext(
        int courseId,
        String courseTitle,
        String courseCode,
        int quizCount,
        int forumMessageCount,
        int studentCount,
        List<String> forumSamples,
        int quizAttempts,
        int quizStudents,
        Integer codeTestPassRate,
        // Score moyen (%) aux quiz auto-corrigés, calculé par core-service ; null si indisponible.
        Integer quizAvgScore) {}
