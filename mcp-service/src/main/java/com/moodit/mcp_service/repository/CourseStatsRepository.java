package com.moodit.mcp_service.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * Compteurs factuels d'un cours pour le contexte d'analyse MCP, lus directement en base
 * partagée via JdbcTemplate. On évite de dupliquer les entités Quiz/Post/Forum/Enrollment
 * de core-service : seules ces 3 agrégations nous intéressent.
 */
@Repository
public class CourseStatsRepository {

    private final JdbcTemplate jdbc;

    public CourseStatsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Nombre de quiz d'un cours. */
    public int countQuizzes(int courseId) {
        return count("SELECT COUNT(*) FROM quiz WHERE course_id = ?", courseId);
    }

    /** Nombre de posts (sujets + réponses) de tous les forums d'un cours. */
    public int countForumMessages(int courseId) {
        return count(
                "SELECT COUNT(*) FROM post p JOIN forum f ON f.id = p.forum_id WHERE f.course_id = ?",
                courseId);
    }

    /**
     * Nombre de VRAIS étudiants inscrits : inscriptions dont l'utilisateur n'a AUCUN rôle programme
     * (Enseignant/Administrateur, via User_Program_Role) dans un programme contenant le cours. Exclut
     * donc le personnel enseignant — dont le créateur du cours, désormais auto-inscrit pour visibilité.
     */
    public int countStudents(int courseId) {
        // NOT EXISTS (et non NOT IN) : évite le piège des NULL et laisse le planificateur court-circuiter.
        Integer n =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM enrollment e "
                                + "WHERE e.course_id = ? "
                                + "AND NOT EXISTS ("
                                + "  SELECT 1 FROM user_program_role upr "
                                + "  JOIN program_course pc ON pc.program_id = upr.program_id "
                                + "  WHERE pc.course_id = ? AND upr.user_id = e.user_id)",
                        Integer.class,
                        courseId,
                        courseId);
        return n == null ? 0 : n;
    }

    /**
     * Échantillon du CONTENU des messages de forum du cours (plus récents d'abord, tronqués),
     * pour laisser le LLM juger le ressenti étudiant. Vide si aucun message.
     */
    public List<String> sampleForumMessages(int courseId, int limit) {
        return jdbc.queryForList(
                "SELECT LEFT(p.content, 400) FROM post p JOIN forum f ON f.id = p.forum_id "
                        + "WHERE f.course_id = ? AND p.content IS NOT NULL AND p.content <> '' "
                        + "ORDER BY p.created_at DESC LIMIT ?",
                String.class, courseId, limit);
    }

    /** Nombre total de tentatives de quiz du cours. */
    public int countQuizAttempts(int courseId) {
        return count(
                "SELECT COUNT(*) FROM attempt a JOIN quiz q ON q.id = a.quiz_id WHERE q.course_id = ?",
                courseId);
    }

    /** Nombre d'étudiants DISTINCTS ayant tenté au moins un quiz du cours. */
    public int countDistinctQuizStudents(int courseId) {
        return count(
                "SELECT COUNT(DISTINCT a.user_id) FROM attempt a JOIN quiz q ON q.id = a.quiz_id "
                        + "WHERE q.course_id = ?",
                courseId);
    }

    /**
     * % de cas de test réussis aux questions de CODE du cours (seul résultat de correction
     * réellement stocké : submission_test_case.passed). {@code null} si aucun test soumis.
     */
    public Integer codeTestPassRate(int courseId) {
        return jdbc.query(
                "SELECT COUNT(*) FILTER (WHERE stc.passed) AS ok, COUNT(*) AS total "
                        + "FROM submission_test_case stc "
                        + "JOIN submission s ON s.id = stc.submission_id "
                        + "JOIN attempt a ON a.id = s.attempt_id "
                        + "JOIN quiz q ON q.id = a.quiz_id "
                        + "WHERE q.course_id = ?",
                rs -> {
                    if (!rs.next()) return null;
                    long total = rs.getLong("total");
                    if (total == 0) return null;
                    long ok = rs.getLong("ok");
                    return (int) Math.round(ok * 100.0 / total);
                },
                courseId);
    }

    private int count(String sql, int courseId) {
        Integer n = jdbc.queryForObject(sql, Integer.class, courseId);
        return n == null ? 0 : n;
    }
}
