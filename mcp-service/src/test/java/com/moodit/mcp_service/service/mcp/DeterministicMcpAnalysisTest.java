package com.moodit.mcp_service.service.mcp;

import static org.assertj.core.api.Assertions.assertThat;

import com.moodit.mcp_service.dto.McpAnalysis;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Repli déterministe : sortie fonction pure des stats, bornée et cohérente avec les chiffres.
 * Sert de filet quand le LLM est indisponible — doit toujours produire une analyse valide.
 */
class DeterministicMcpAnalysisTest {

    private static CourseAnalysisContext ctx(
            int quizzes, int messages, int students, int attempts, int quizStudents,
            Integer codeRate, Integer quizAvg) {
        return new CourseAnalysisContext(
                1, "Titre", "C1", quizzes, messages, students,
                List.of(), attempts, quizStudents, codeRate, quizAvg);
    }

    @Test
    void emptyCourse_isLowAndFlaggedAsFallback() {
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(0, 0, 0, 0, 0, null, null));

        assertThat(a.score()).isBetween(0, 100);
        // Sources = compteurs réels réinjectés.
        assertThat(a.sources().quizCount()).isZero();
        assertThat(a.sources().forumMessageCount()).isZero();
        assertThat(a.sources().studentCount()).isZero();
        // Sans LLM le ressenti n'est pas analysable, et sans note/code la réussite non plus → N/D.
        assertThat(a.dimensions().sentiment()).isNull();
        assertThat(a.dimensions().success()).isNull();
        assertThat(a.improvements()).isNotEmpty();
        assertThat(a.summary()).contains("secours");
    }

    @Test
    void richCourse_isHigh_scoreClampedTo100() {
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(10, 40, 20, 30, 15, 78, 85));

        // 40 + min(10,8)*4 + min(40,40)/2 + min(20,20) = 40+32+20+20 = 112 → borné à 100.
        assertThat(a.score()).isEqualTo(100);
        // success privilégie la moyenne quiz quand elle existe ; ressenti N/D sans LLM.
        assertThat(a.dimensions().success()).isEqualTo(85);
        assertThat(a.dimensions().sentiment()).isNull();
        assertThat(a.sources().quizCount()).isEqualTo(10);
        assertThat(a.strengths()).hasSizeGreaterThanOrEqualTo(4);
    }

    @Test
    void dimensions_areClampedTo100() {
        // content = min(10,8)*12 + 4 = 100 ; engagement = min(40,40)*2 + min(30,20)*2 = 120 → 100.
        McpAnalysis.Dimensions d =
                DeterministicMcpAnalysis.compute(ctx(10, 40, 5, 30, 5, null, null)).dimensions();
        assertThat(d.content()).isEqualTo(100);
        assertThat(d.engagement()).isEqualTo(100);
    }

    @Test
    void success_fallsBackToCodeRate_whenNoQuizAverage() {
        McpAnalysis.Dimensions d =
                DeterministicMcpAnalysis.compute(ctx(2, 3, 3, 4, 2, 65, null)).dimensions();
        assertThat(d.success()).isEqualTo(65);
    }

    // ── Compléments (#90) : chaque branche du repli produit un message cohérent ──

    @Test
    void emptyCourse_scoreDeBase40_etRecommandationsDeLancement() {
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(0, 0, 0, 0, 0, null, null));

        // Base 40 sans aucune contribution ; « peu actif » sous 45.
        assertThat(a.score()).isEqualTo(40);
        assertThat(a.summary()).startsWith("Cours peu actif : 0 quiz, 0 message(s) de forum, 0 inscrit(s).");
        assertThat(a.dimensions().content()).isZero();
        assertThat(a.dimensions().engagement()).isZero();
        assertThat(a.improvements()).contains(
                "Ajouter des quiz : aucune évaluation formative n'est disponible.",
                "Animer les forums : aucun message n'a encore été publié.",
                "Renforcer les inscriptions : seulement 0 étudiant(s) pour l'instant.");
        // Contrat du front : au moins 2 points forts, même pour un cours vide (complément générique).
        assertThat(a.strengths()).containsExactly(
                "La structure du cours est en place et prête à être enrichie.");
        assertThat(a.recommendations()).containsExactly(
                "Ajouter des quiz pour évaluer régulièrement les acquis.",
                "Animer les forums (questions, annonces) pour stimuler les échanges.",
                "Promouvoir le cours pour augmenter le nombre d'inscrits.");
    }

    @Test
    void forumFaible_quizSansTentative_etReussitesMoyennes() {
        // 2 quiz, 4 messages, 6 inscrits, aucune tentative, quiz 60 %, code 55 %.
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(2, 4, 6, 0, 0, 55, 60));

        // 40 + 2*4 + 4/2 + 6 = 56 → « d'activité moyenne ».
        assertThat(a.score()).isEqualTo(56);
        assertThat(a.summary()).startsWith("Cours d'activité moyenne : 2 quiz, 4 message(s) de forum, 6 inscrit(s)");
        assertThat(a.summary()).contains("(réussite quiz 60%)", "(code 55%)");
        assertThat(a.summary()).doesNotContain("tentative(s)");
        assertThat(a.strengths()).contains(
                "Le cours propose 2 quiz pour évaluer les acquis.",
                "6 étudiants sont inscrits au cours.");
        assertThat(a.improvements()).contains(
                "Stimuler les échanges : l'activité de forum reste faible (4 messages).",
                "Inciter les étudiants à faire les quiz : aucune tentative enregistrée.",
                "Réussite aux quiz moyenne (60%) : consolider les acquis.",
                "Réussite au code moyenne (55% des tests) : renforcer la pratique.");
        assertThat(a.recommendations()).containsExactly(
                "Animer les forums (questions, annonces) pour stimuler les échanges.",
                "Inciter les étudiants à réaliser les quiz déjà publiés.");
        // content = 2*12 + 4 = 28 ; engagement = 4*2 + 0 = 8 ; success = moyenne quiz prioritaire.
        assertThat(a.dimensions().content()).isEqualTo(28);
        assertThat(a.dimensions().engagement()).isEqualTo(8);
        assertThat(a.dimensions().success()).isEqualTo(60);
    }

    @Test
    void reussitesFaibles_declenchentAmeliorationsEtRecommandations() {
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(8, 40, 20, 10, 8, 30, 40));

        assertThat(a.improvements()).contains(
                "Réussite aux quiz faible (40% de moyenne) : revoir les notions clés.",
                "Réussite au code faible (30% des tests) : revoir les notions de programmation.");
        assertThat(a.recommendations()).contains(
                "Revoir les notions les moins réussies aux quiz.",
                "Renforcer la pratique du code par des exercices guidés.");
        assertThat(a.strengths()).contains(
                "10 tentative(s) de quiz par 8 étudiant(s) : les quiz sont réellement utilisés.",
                "Les forums sont actifs (40 messages échangés).");
        assertThat(a.summary()).startsWith("Cours en bonne santé");
    }

    @Test
    void bonnesReussites_sontDesPointsForts_etRecommandationGeneriqueSiRienAFaire() {
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(8, 40, 20, 10, 8, 90, 85));

        assertThat(a.strengths()).contains(
                "Bonne réussite aux quiz : 85% de moyenne.",
                "Bonne réussite au code : 90% des cas de test réussis.");
        // Aucun signal faible : complément générique pour garantir 2 recommandations / améliorations.
        assertThat(a.recommendations()).containsExactly(
                "Maintenir le rythme et solliciter régulièrement les étudiants.");
        assertThat(a.improvements()).containsExactly(
                "Diversifier les contenus et solliciter régulièrement les étudiants.");
    }

    @Test
    void codeEntre40Et50_estMoyen_maisRecommandeQuandMemeLaPratique() {
        // Seuils différents : amélioration « moyenne » (>=40) mais recommandation (<50).
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(8, 40, 20, 10, 8, 45, null));

        assertThat(a.improvements()).contains(
                "Réussite au code moyenne (45% des tests) : renforcer la pratique.");
        assertThat(a.recommendations()).contains(
                "Renforcer la pratique du code par des exercices guidés.");
        assertThat(a.dimensions().success()).isEqualTo(45);
    }

    @Test
    void seuilsDeReussite_70estBon_50estMoyen() {
        McpAnalysis bon = DeterministicMcpAnalysis.compute(ctx(1, 0, 0, 0, 0, 70, 70));
        McpAnalysis moyen = DeterministicMcpAnalysis.compute(ctx(1, 0, 0, 0, 0, null, 50));

        assertThat(bon.strengths()).contains(
                "Bonne réussite aux quiz : 70% de moyenne.",
                "Bonne réussite au code : 70% des cas de test réussis.");
        assertThat(moyen.improvements()).contains("Réussite aux quiz moyenne (50%) : consolider les acquis.");
        assertThat(moyen.recommendations()).doesNotContain("Revoir les notions les moins réussies aux quiz.");
    }

    // ---- Seuils exacts (tests de mutation : chaque borne est vérifiée des deux côtés) ----

    @Test
    void forum_dixMessagesSontUneForce_neufUneFaiblesse() {
        McpAnalysis dix = DeterministicMcpAnalysis.compute(ctx(1, 10, 5, 1, 1, null, null));
        McpAnalysis neuf = DeterministicMcpAnalysis.compute(ctx(1, 9, 5, 1, 1, null, null));

        assertThat(dix.strengths()).contains("Les forums sont actifs (10 messages échangés).");
        assertThat(dix.recommendations())
                .doesNotContain("Animer les forums (questions, annonces) pour stimuler les échanges.");
        assertThat(neuf.improvements())
                .contains("Stimuler les échanges : l'activité de forum reste faible (9 messages).");
        assertThat(neuf.recommendations())
                .contains("Animer les forums (questions, annonces) pour stimuler les échanges.");
    }

    @Test
    void inscriptions_cinqEtudiantsSontUneForce_quatreUneFaiblesse() {
        McpAnalysis cinq = DeterministicMcpAnalysis.compute(ctx(1, 10, 5, 1, 1, null, null));
        McpAnalysis quatre = DeterministicMcpAnalysis.compute(ctx(1, 10, 4, 1, 1, null, null));

        assertThat(cinq.strengths()).contains("5 étudiants sont inscrits au cours.");
        assertThat(cinq.recommendations())
                .doesNotContain("Promouvoir le cours pour augmenter le nombre d'inscrits.");
        assertThat(quatre.improvements())
                .contains("Renforcer les inscriptions : seulement 4 étudiant(s) pour l'instant.");
        assertThat(quatre.recommendations())
                .contains("Promouvoir le cours pour augmenter le nombre d'inscrits.");
    }

    @Test
    void sansQuizNiTentative_onNIncitePasAFaireDesQuizInexistants() {
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(0, 0, 0, 0, 0, null, null));

        assertThat(a.improvements())
                .doesNotContain("Inciter les étudiants à faire les quiz : aucune tentative enregistrée.");
        assertThat(a.recommendations())
                .doesNotContain("Inciter les étudiants à réaliser les quiz déjà publiés.");
    }

    @Test
    void code_quaranteEstMoyen_trenteNeufEstFaible() {
        McpAnalysis quarante = DeterministicMcpAnalysis.compute(ctx(1, 10, 5, 1, 1, 40, null));
        McpAnalysis trenteNeuf = DeterministicMcpAnalysis.compute(ctx(1, 10, 5, 1, 1, 39, null));

        assertThat(quarante.improvements())
                .contains("Réussite au code moyenne (40% des tests) : renforcer la pratique.");
        assertThat(trenteNeuf.improvements())
                .contains("Réussite au code faible (39% des tests) : revoir les notions de programmation.");
    }

    @Test
    void code_recommandationDePratiqueSousCinquante_pasACinquante() {
        McpAnalysis cinquante = DeterministicMcpAnalysis.compute(ctx(1, 10, 5, 1, 1, 50, null));
        McpAnalysis quaranteNeuf = DeterministicMcpAnalysis.compute(ctx(1, 10, 5, 1, 1, 49, null));

        assertThat(cinquante.recommendations())
                .doesNotContain("Renforcer la pratique du code par des exercices guidés.");
        assertThat(quaranteNeuf.recommendations())
                .contains("Renforcer la pratique du code par des exercices guidés.");
    }

    @Test
    void deuxForcesEtDeuxAxes_aucuneEntreeGeneriqueAjoutee() {
        // 1 quiz (force), forum 10 (force) ; 4 étudiants (axe), aucune tentative (axe).
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(1, 10, 4, 0, 0, null, null));
        // Forces : quiz + forum = exactement 2 → pas de complément générique.
        assertThat(a.strengths()).hasSize(2)
                .doesNotContain("La structure du cours est en place et prête à être enrichie.");
        // Axes : inscriptions + tentatives = exactement 2 → pas de complément générique.
        assertThat(a.improvements()).hasSize(2)
                .doesNotContain("Diversifier les contenus et solliciter régulièrement les étudiants.");
    }

    @Test
    void uneSeuleForce_completeeParUneEntreeGenerique() {
        // 0 quiz (axe), forum 10 (force), 4 étudiants (axe) → une seule force réelle.
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(0, 10, 4, 0, 0, null, null));
        assertThat(a.strengths()).containsExactly(
                "Les forums sont actifs (10 messages échangés).",
                "La structure du cours est en place et prête à être enrichie.");
    }

    @Test
    void sante_seuilsExactsA75Et45() {
        // score = 40 + quiz*4 + forum/2 + étudiants.
        // 75 = 40 + 8*4 (32) + 0 + 3 ; 74 = 40 + 32 + 0 + 2.
        assertThat(DeterministicMcpAnalysis.compute(ctx(8, 0, 3, 0, 0, null, null)).summary())
                .startsWith("Cours en bonne santé :");
        assertThat(DeterministicMcpAnalysis.compute(ctx(8, 0, 2, 0, 0, null, null)).summary())
                .startsWith("Cours d'activité moyenne :");
        // 45 = 40 + 1*4 + 0 + 1 ; 44 = 40 + 4 + 0 + 0.
        assertThat(DeterministicMcpAnalysis.compute(ctx(1, 0, 1, 0, 0, null, null)).summary())
                .startsWith("Cours d'activité moyenne :");
        assertThat(DeterministicMcpAnalysis.compute(ctx(1, 0, 0, 0, 0, null, null)).summary())
                .startsWith("Cours peu actif :");
    }
}
