package com.moodit.core_service.repository;

import org.springframework.data.jpa.repository.JpaRepository;
//Model
import com.moodit.core_service.model.Post;

public interface PostRepository extends JpaRepository<Post, Integer> {

    /** Nombre de posts (sujets + réponses) de tous les forums d'un cours (contexte MCP). */
    long countByForum_Course_Id(Integer courseId);
}
