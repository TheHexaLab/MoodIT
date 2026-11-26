package com.moodit.core_service.repository;

import com.moodit.core_service.model.Attempt;

import org.springframework.data.jpa.repository.JpaRepository;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface AttemptRepository extends JpaRepository<Attempt, Integer> {

    /** Tentatives d'un utilisateur sur un quiz, dans l'ordre (1, 2, …). */
    List<Attempt> findByQuiz_IdAndUser_IdOrderByAttemptNoAsc(Integer quizId, Integer userId);

    /**
     * Contrôle préalable d'une soumission, en UNE requête — donc un seul instantané en READ
     * COMMITTED : nombre de tentatives (tentative unique), plus grand {@code attempt_no} (numéro
     * de la prochaine : max + 1) et pending éventuel avec son marqueur de relance (409
     * « en_cours » avec son id, ou « relance » / « déjà soumis »). Lus en plusieurs requêtes, un
     * pending validé ou SUPPRIMÉ entre deux lectures était compté sans être vu (ou l'inverse) :
     * « déjà soumis » à tort, ou un trou de numérotation qui, avec un numéro calculé sur le
     * comptage, faisait collisionner chaque soumission suivante sur
     * {@code UNIQUE(quiz,user,attempt_no)} — l'étudiant ne pouvait plus jamais soumettre.
     * Une ligne d'agrégats, toujours une, même sans tentative.
     */
    @Query("SELECT new com.moodit.core_service.repository.AttemptSnapshot("
            + "COUNT(a), COALESCE(MAX(a.attemptNo), 0), "
            + "MAX(CASE WHEN a.status = 'pending' THEN a.id END), "
            + "COALESCE(MAX(CASE WHEN a.status = 'pending' AND a.regrade = true THEN 1 ELSE 0 END), 0)) "
            + "FROM Attempt a WHERE a.quiz.id = :quizId AND a.user.id = :userId")
    AttemptSnapshot snapshotForSubmission(@Param("quizId") Integer quizId, @Param("userId") Integer userId);

    /**
     * Dernière tentative de l'utilisateur sur ce quiz (plus grand {@code attempt_no}), quel que
     * soit son statut. Après un conflit d'insertion, c'est celle de l'écriture concurrente — déjà
     * corrigée peut-être — SEULEMENT si son numéro atteint celui que la soumission refusée a tenté
     * d'insérer (QuizService#submitQuiz) : plus ancienne, ce n'est pas elle — la concurrente a
     * disparu entre-temps, ou c'était une relance d'une ancienne tentative, finie avant la
     * relecture — et l'id est omis du 409 « en_cours ».
     */
    Optional<Attempt> findFirstByQuiz_IdAndUser_IdOrderByAttemptNoDesc(Integer quizId, Integer userId);

    /**
     * Vrai s'il existe une tentative dans ce statut, restreint au marqueur de relance : un
     * {@code "pending"} avec {@code regrade = true} est une RELANCE de l'enseignant, pas la
     * correction d'une soumission de l'étudiant (409 « relance » au lieu de « en_cours » sur un
     * quiz avec reprise, « déjà soumis » sans reprise). Relu après un conflit d'insertion ; le
     * contrôle préalable, lui, le lit dans {@link #snapshotForSubmission}.
     */
    boolean existsByQuiz_IdAndUser_IdAndStatusAndRegrade(
            Integer quizId, Integer userId, String status, boolean regrade);

    /**
     * Tentatives d'un statut donné, plus anciennes d'abord : au démarrage de core, les
     * {@code "pending"} dont la correction a été perdue (cf. QuizGradingListener).
     */
    List<Attempt> findByStatusOrderByIdAsc(String status);

    /** Tentatives d'un quiz dans un statut donné, les plus anciennes d'abord (« à revoir », #116 S4). */
    List<Attempt> findByQuiz_IdAndStatusOrderBySubmittedAtAscIdAsc(Integer quizId, String status);

    /**
     * Nombre de tentatives dans un statut donné, par quiz d'un cours : {@code [quizId, nombre]}.
     * UNE requête pour toute la liste de l'éditeur (compteur « à revoir », #116 S4).
     */
    @Query("SELECT a.quiz.id, COUNT(a) FROM Attempt a"
            + " WHERE a.quiz.course.id = :courseId AND a.status = :status GROUP BY a.quiz.id")
    List<Object[]> countByStatusPerQuiz(@Param("courseId") Integer courseId, @Param("status") String status);

    /**
     * Tentative VERROUILLÉE en écriture jusqu'à la fin de la transaction ({@code SELECT … FOR
     * UPDATE}). Sert à l'abandon d'une correction : le statut relu sous verrou dit si une autre
     * passe l'a finalisée en {@code "done"} entre-temps, auquel cas elle n'est pas supprimée.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Attempt a WHERE a.id = :id")
    Optional<Attempt> findByIdForUpdate(@Param("id") Integer id);

    /** Une tentative précise, restreinte à son propriétaire (autorisation). */
    Optional<Attempt> findByIdAndUser_Id(Integer id, Integer userId);

    /**
     * Toutes les tentatives (tous utilisateurs) des quiz d'un cours — agrégat de réussite MCP —
     * avec leur quiz, leur auteur et leurs soumissions (et la question de chacune) dans la MÊME
     * requête : pas de requête par tentative (N+1). Les verdicts de tests des soumissions sont
     * chargés à part ({@link SubmissionRepository#findWithTestCaseResultsByCourseId}) : deux
     * collections {@code List} ne se chargent pas dans une seule requête.
     */
    @Query("SELECT DISTINCT a FROM Attempt a JOIN FETCH a.quiz JOIN FETCH a.user"
            + " LEFT JOIN FETCH a.submissions s LEFT JOIN FETCH s.question"
            + " WHERE a.quiz.course.id = :courseId")
    List<Attempt> findWithSubmissionsByCourseId(@Param("courseId") Integer courseId);
}
