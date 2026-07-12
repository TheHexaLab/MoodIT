package com.moodit.core_service.repository;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.Vote;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface VoteRepository extends JpaRepository<Vote, Integer> {
    Optional<Vote> findByUserIdAndPostId(Integer userId, Integer postId);

    /**
     * Somme des votes GROUPÉE par post, pour un lot de posts. Évite le N+1 (1 requête au lieu
     * d'un chargement de la collection `votes` par post). Chaque ligne = [postId, sumValue].
     */
    @Query(
        "SELECT v.post.id, SUM(v.value) FROM Vote v WHERE v.post.id IN :postIds GROUP BY v.post.id")
    List<Object[]> sumValueByPostIds(@Param("postIds") List<Integer> postIds);

    /**
     * Vote PROPRE de l'utilisateur pour un lot de posts (1 requête). Chaque ligne = [postId, value]
     * (au plus une par post : contrainte UNIQUE (user_id, post_id)).
     */
    @Query(
        "SELECT v.post.id, v.value FROM Vote v"
            + " WHERE v.user.id = :userId AND v.post.id IN :postIds")
    List<Object[]> valueByUserAndPostIds(
        @Param("userId") Integer userId, @Param("postIds") List<Integer> postIds);
}
