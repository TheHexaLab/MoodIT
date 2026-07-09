//S'occupe de faire les requêtes - JPA s'occupe de quelques commandes de bases
/*
Lecture
    findAll()
    findById(Long id)
    findAll(Sort sort)
    findAll(Pageable pageable)
    count()

Écriture
    save(User user)
    saveAll(List<User> users)

Suppression
    deleteById(Long id)
    delete(User user)
    deleteAll()

Vérification
    existsById(Long id)
*/

package com.moodit.core_service.repository;

//Model
import com.moodit.core_service.model.Program;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface ProgramRepository extends JpaRepository<Program, Integer> {

    /**
     * Ids des programmes d'un établissement — PROJECTION (pas d'entités gérées). Sert à la
     * suppression d'un établissement : on récupère les ids sans charger de `Program` managés
     * (Hibernate ne tente ainsi rien sur eux ; la suppression repose sur la cascade BD).
     */
    @Query("SELECT p.id FROM Program p WHERE p.establishment.id = :establishmentId")
    List<Integer> findProgramIdsByEstablishmentId(@Param("establishmentId") Integer establishmentId);

    /** Programmes d'un établissement (pour l'écho catalogue temps réel : liste à jour). */
    List<Program> findByEstablishment_Id(Integer establishmentId);

    /**
     * Programmes d'un établissement où l'utilisateur est « Administrateur » ou « Enseignant »
     * (User_Program_Role) : ceux dans lesquels il peut ajouter un cours. (Un admin global / gardien
     * bypasse ce filtre côté service et voit TOUS les programmes de l'établissement.)
     */
    @Query(
        value =
            """
            SELECT DISTINCT p.*
            FROM program p
            JOIN user_program_role upr ON upr.program_id = p.id
            JOIN role r                ON r.id = upr.role_id
            WHERE p.establishment_id = :establishmentId
              AND upr.user_id = :userId
              AND r.name IN ('Administrateur', 'Enseignant')
            ORDER BY p.id
            """,
        nativeQuery = true)
    List<Program> findManageableInEstablishment(
        @Param("userId") Integer userId, @Param("establishmentId") Integer establishmentId);
}
