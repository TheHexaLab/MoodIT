package com.moodit.core_service.repository;

//Model
import com.moodit.core_service.model.User;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface UserRepository extends JpaRepository<User, Integer> {

    Optional<User> findByUsername(String username);
    List<User> findByPrograms_IdAndRoles_Id(Integer programId, Integer roleId);
    Optional<User> findByEmail(String email);

    List<User> findDistinctByPrograms_Id(Integer programId);

    /** Utilisateurs ayant AU MOINS un rôle GLOBAL (plateforme) — les administrateurs actuels. */
    @Query(
        "SELECT DISTINCT u FROM User u JOIN u.roles r WHERE r.globalAssignable = true"
            + " ORDER BY u.firstName, u.lastName, u.id")
    List<User> findUsersWithGlobalRole();

    /**
     * Candidats à l'attribution d'un rôle GLOBAL : utilisateurs n'ayant PAS déjà `roleId`,
     * filtrés par `q` (préfixe insensible à la casse sur prénom/nom/username/email ; `q` vide
     * = tous). Paginé via `pageable` (infinite scroll côté front).
     */
    @Query(
        "SELECT u FROM User u"
            + " WHERE NOT EXISTS (SELECT r FROM u.roles r WHERE r.id = :roleId)"
            + " AND (:q = ''"
            + "   OR LOWER(u.firstName) LIKE CONCAT('%', :q, '%')"
            + "   OR LOWER(u.lastName) LIKE CONCAT('%', :q, '%')"
            + "   OR LOWER(u.username) LIKE CONCAT('%', :q, '%')"
            + "   OR LOWER(u.email) LIKE CONCAT('%', :q, '%'))"
            + " ORDER BY u.firstName, u.lastName, u.id")
    List<User> findGlobalRoleCandidates(
        @Param("roleId") Integer roleId, @Param("q") String q, Pageable pageable);

    /**
     * Candidats à l'attribution d'un rôle DANS un programme : utilisateurs MEMBRES du programme
     * (User_Program) n'ayant PAS déjà `roleId` dans ce programme (User_Program_Role), filtrés par
     * `q` (préfixe insensible à la casse ; `q` vide = tous). Paginé (infinite scroll côté front).
     */
    @Query(
        "SELECT u FROM User u JOIN u.programs p"
            + " WHERE p.id = :programId"
            + " AND NOT EXISTS (SELECT upr FROM UserProgramRole upr"
            + "   WHERE upr.programId = :programId AND upr.userId = u.id AND upr.roleId = :roleId)"
            + " AND (:q = ''"
            + "   OR LOWER(u.firstName) LIKE CONCAT('%', :q, '%')"
            + "   OR LOWER(u.lastName) LIKE CONCAT('%', :q, '%')"
            + "   OR LOWER(u.username) LIKE CONCAT('%', :q, '%')"
            + "   OR LOWER(u.email) LIKE CONCAT('%', :q, '%'))"
            + " ORDER BY u.firstName, u.lastName, u.id")
    List<User> findProgramRoleCandidates(
        @Param("programId") Integer programId,
        @Param("roleId") Integer roleId,
        @Param("q") String q,
        Pageable pageable);
}
