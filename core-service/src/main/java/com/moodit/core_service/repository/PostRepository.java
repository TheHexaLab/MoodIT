package com.moodit.core_service.repository;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
//Model
import com.moodit.core_service.model.Post;

public interface PostRepository extends JpaRepository<Post, Integer> {

    /**
     * Post d'un forum, VERROUILLÉ en écriture jusqu'à la fin de la transaction ({@code SELECT … FOR
     * UPDATE}). Sert à sérialiser les votes sur un même post : sans verrou, deux votes simultanés
     * lisaient le même état puis écrivaient chacun le leur (409 sur la contrainte UNIQUE, ou
     * bascule appliquée sur un état périmé). Vide si le post n'existe pas ou n'est pas dans ce
     * forum.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT p FROM Post p WHERE p.id = :postId AND p.forum.id = :forumId")
    Optional<Post> findByIdAndForumIdForUpdate(
        @Param("postId") Integer postId, @Param("forumId") Integer forumId);

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

    /**
     * Nombre de réponses directes GROUPÉ par post parent, pour un lot de posts. Évite le N+1
     * (1 requête au lieu de `post.getChildren().size()` par post). Chaque ligne = [parentId, count].
     */
    @Query(
        "SELECT p.parent.id, COUNT(p) FROM Post p WHERE p.parent.id IN :parentIds"
            + " GROUP BY p.parent.id")
    List<Object[]> countChildrenByParentIds(@Param("parentIds") List<Integer> parentIds);

    /**
     * Détache (parent → NULL) les réponses DIRECTES d'un post, EN MASSE (contourne le contexte de
     * persistance et donc la cascade JPA `children` REMOVE/orphanRemoval). Utilisé avant de
     * supprimer un message de DISCUSSION : ses réponses SURVIVENT (une réponse ne disparaît pas
     * avec le message auquel elle répond). Ne concerne PAS les Threads (cascade conservée).
     */
    @Modifying
    @Query("UPDATE Post p SET p.parent = null WHERE p.parent.id = :parentId")
    void detachDirectChildren(@Param("parentId") Integer parentId);
}
