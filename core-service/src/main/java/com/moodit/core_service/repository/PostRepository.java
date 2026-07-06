package com.moodit.core_service.repository;

import java.util.List;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
//Model
import com.moodit.core_service.model.Post;

public interface PostRepository extends JpaRepository<Post, Integer> {

    /** Nombre de posts (sujets + réponses) de tous les forums d'un cours (contexte MCP). */
    long countByForum_Course_Id(Integer courseId);

    /**
     * Page de messages d'un canal (racines ET réponses, à plat), du plus RÉCENT au plus ancien.
     * Pagination par CURSEUR : `before` = id du plus ancien déjà chargé (null = page la plus
     * récente). `id < :before` charge les messages plus ANCIENS. `pageable` porte la limite.
     *
     * NB : le curseur par id suppose que l'ordre des id (SERIAL, monotone croissant à l'insertion)
     * correspond à l'ordre chronologique (created_at). Vrai tant que les posts sont insérés dans
     * l'ordre — le cas ici. Un import/backfill hors ordre casserait cette hypothèse.
     */
    @Query(
        "SELECT p FROM Post p WHERE p.forum.id = :forumId"
            + " AND (:before IS NULL OR p.id < :before)"
            + " ORDER BY p.id DESC")
    List<Post> findMessagesPage(
        @Param("forumId") Integer forumId, @Param("before") Integer before, Pageable pageable);

    /**
     * Page de sujets RACINES d'un forum (parent IS NULL), du plus RÉCENT au plus ancien.
     * Pagination par CURSEUR : `before` = id du plus ancien sujet déjà affiché (null = page la
     * plus récente). `pageable` porte la limite.
     */
    @Query(
        "SELECT p FROM Post p WHERE p.forum.id = :forumId AND p.parent IS NULL"
            + " AND (:before IS NULL OR p.id < :before)"
            + " ORDER BY p.id DESC")
    List<Post> findRootPostsPage(
        @Param("forumId") Integer forumId, @Param("before") Integer before, Pageable pageable);
}
