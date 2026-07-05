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
        // Sans LLM, le ressenti n'est pas calculable → neutre 50.
        assertThat(a.dimensions().sentiment()).isEqualTo(50);
        assertThat(a.improvements()).isNotEmpty();
        assertThat(a.summary()).contains("secours");
    }

    @Test
    void richCourse_isHigh_scoreClampedTo100() {
        McpAnalysis a = DeterministicMcpAnalysis.compute(ctx(10, 40, 20, 30, 15, 78, 85));

        // 40 + min(10,8)*4 + min(40,40)/2 + min(20,20) = 40+32+20+20 = 112 → borné à 100.
        assertThat(a.score()).isEqualTo(100);
        // success privilégie la moyenne quiz quand elle existe.
        assertThat(a.dimensions().success()).isEqualTo(85);
        assertThat(a.dimensions().sentiment()).isEqualTo(50);
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
}
