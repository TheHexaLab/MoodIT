package com.moodit.mcp_service.service.mcp;

import com.moodit.mcp_service.dto.McpAnalysis;

import java.util.ArrayList;
import java.util.List;

/**
 * Repli DÉTERMINISTE de l'analyse, calculé uniquement à partir des vraies statistiques du
 * cours (aucun appel réseau). Utilisé quand le LLM est indisponible (pas de clé, service
 * éteint, JSON illisible…) : garantit qu'une analyse aboutit toujours — indispensable pour
 * une démo/soutenance sans dépendre d'Ollama. Les libellés sont volontairement génériques
 * mais cohérents avec les chiffres.
 */
public final class DeterministicMcpAnalysis {

    private DeterministicMcpAnalysis() {}

    public static McpAnalysis compute(CourseAnalysisContext ctx) {
        int quizzes = ctx.quizCount();
        int messages = ctx.forumMessageCount();
        int students = ctx.studentCount();

        // Score borné : base 40 + contributions plafonnées de chaque axe.
        int quizPoints = Math.min(quizzes, 8) * 4;       // offre de quiz      → jusqu'à +32
        int forumPoints = Math.min(messages, 40) / 2;    // activité de forum  → jusqu'à +20
        int audiencePoints = Math.min(students, 20);     // audience           → jusqu'à +20
        int score = Math.max(0, Math.min(100, 40 + quizPoints + forumPoints + audiencePoints));

        List<String> strengths = new ArrayList<>();
        List<String> improvements = new ArrayList<>();

        if (quizzes > 0) {
            strengths.add("Le cours propose " + quizzes + " quiz pour évaluer les acquis.");
        } else {
            improvements.add("Ajouter des quiz : aucune évaluation formative n'est disponible.");
        }

        if (messages >= 10) {
            strengths.add("Les forums sont actifs (" + messages + " messages échangés).");
        } else if (messages > 0) {
            improvements.add("Stimuler les échanges : l'activité de forum reste faible ("
                    + messages + " messages).");
        } else {
            improvements.add("Animer les forums : aucun message n'a encore été publié.");
        }

        if (students >= 5) {
            strengths.add(students + " étudiants sont inscrits au cours.");
        } else {
            improvements.add("Renforcer les inscriptions : seulement " + students
                    + " étudiant(s) pour l'instant.");
        }

        // Participation aux quiz (sans LLM, on ne juge pas le ressenti — pas d'analyse de texte).
        if (ctx.quizAttempts() > 0) {
            strengths.add(ctx.quizAttempts() + " tentative(s) de quiz par "
                    + ctx.quizStudents() + " étudiant(s) : les quiz sont réellement utilisés.");
        } else if (quizzes > 0) {
            improvements.add("Inciter les étudiants à faire les quiz : aucune tentative enregistrée.");
        }

        // Réussite moyenne aux quiz auto-corrigés (calculée par core, jamais stockée).
        Integer quizScore = ctx.quizAvgScore();
        if (quizScore != null) {
            if (quizScore >= 70) {
                strengths.add("Bonne réussite aux quiz : " + quizScore + "% de moyenne.");
            } else if (quizScore < 50) {
                improvements.add("Réussite aux quiz faible (" + quizScore
                        + "% de moyenne) : revoir les notions clés.");
            } else {
                improvements.add("Réussite aux quiz moyenne (" + quizScore
                        + "%) : consolider les acquis.");
            }
        }

        // Réussite aux questions de code (résultats des tests, stockés en base).
        Integer codeRate = ctx.codeTestPassRate();
        if (codeRate != null) {
            if (codeRate >= 70) {
                strengths.add("Bonne réussite au code : " + codeRate + "% des cas de test réussis.");
            } else if (codeRate < 40) {
                improvements.add("Réussite au code faible (" + codeRate
                        + "% des tests) : revoir les notions de programmation.");
            } else {
                improvements.add("Réussite au code moyenne (" + codeRate
                        + "% des tests) : renforcer la pratique.");
            }
        }

        // Garantit 2 entrées minimum de chaque côté (contrat du front : 2 à 4).
        if (strengths.size() < 2) {
            strengths.add("La structure du cours est en place et prête à être enrichie.");
        }
        if (improvements.size() < 2) {
            improvements.add("Diversifier les contenus et solliciter régulièrement les étudiants.");
        }

        // Recommandations actionnables déduites des signaux faibles.
        List<String> recommendations = new ArrayList<>();
        if (quizzes == 0) {
            recommendations.add("Ajouter des quiz pour évaluer régulièrement les acquis.");
        }
        if (messages < 10) {
            recommendations.add("Animer les forums (questions, annonces) pour stimuler les échanges.");
        }
        if (students < 5) {
            recommendations.add("Promouvoir le cours pour augmenter le nombre d'inscrits.");
        }
        if (ctx.quizAttempts() == 0 && quizzes > 0) {
            recommendations.add("Inciter les étudiants à réaliser les quiz déjà publiés.");
        }
        if (quizScore != null && quizScore < 50) {
            recommendations.add("Revoir les notions les moins réussies aux quiz.");
        }
        if (codeRate != null && codeRate < 50) {
            recommendations.add("Renforcer la pratique du code par des exercices guidés.");
        }
        if (recommendations.size() < 2) {
            recommendations.add("Maintenir le rythme et solliciter régulièrement les étudiants.");
        }

        // Sous-scores par dimension (sentiment non calculable sans LLM → neutre 50).
        // success : priorité au score moyen aux quiz, sinon réussite au code, sinon participation.
        int content = clamp(Math.min(quizzes, 8) * 12 + (quizzes > 0 ? 4 : 0));
        int engagement = clamp(Math.min(messages, 40) * 2 + Math.min(ctx.quizAttempts(), 20) * 2);
        // N/D (null) quand rien à mesurer : réussite sans note ni code ; ressenti TOUJOURS N/D en
        // repli (aucune analyse de texte possible sans LLM).
        Integer success = quizScore != null ? quizScore : codeRate;
        Integer sentiment = null;
        McpAnalysis.Dimensions dimensions =
                new McpAnalysis.Dimensions(content, engagement, success, sentiment);

        String health = score >= 75 ? "en bonne santé" : score >= 45 ? "d'activité moyenne" : "peu actif";
        String summary = "Cours " + health + " : " + quizzes + " quiz, " + messages
                + " message(s) de forum, " + students + " inscrit(s)"
                + (ctx.quizAttempts() > 0 ? ", " + ctx.quizAttempts() + " tentative(s) de quiz" : "")
                + (quizScore != null ? " (réussite quiz " + quizScore + "%)" : "")
                + (codeRate != null ? " (code " + codeRate + "%)" : "")
                + ". Analyse de secours automatique (service IA momentanément indisponible).";

        return new McpAnalysis(
                score,
                summary,
                dimensions,
                strengths,
                improvements,
                recommendations,
                new McpAnalysis.Sources(quizzes, messages, students));
    }

    private static int clamp(int v) {
        return Math.max(0, Math.min(100, v));
    }
}
