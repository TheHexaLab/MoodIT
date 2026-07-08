package com.moodit.core_service.dto;

/**
 * Agrégat de réussite aux quiz d'un COURS, calculé à la volée (aucune note stockée) en
 * réutilisant la correction de {@code QuizService}. Les questions de CODE sont EXCLUES du
 * calcul (core ne les note pas — 0 point), leur réussite est mesurée séparément (tests).
 * Consommé par mcp-service via l'endpoint interne pour enrichir l'analyse de cours.
 *
 * @param averageScorePercent moyenne des % de réussite par tentative (auto-corrigés) ; null si
 *                            aucune tentative notable (pas de question auto-corrigée tentée)
 * @param gradedAttemptCount  nombre de tentatives ayant au moins une question auto-corrigée
 * @param studentCount        nombre d'étudiants distincts concernés
 */
public record CourseQuizStatsDTO(
        Integer averageScorePercent,
        int gradedAttemptCount,
        int studentCount) {}
