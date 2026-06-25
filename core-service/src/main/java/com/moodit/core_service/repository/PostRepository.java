package com.moodit.core_service.repository;

import org.springframework.data.jpa.repository.JpaRepository;
//Model
import com.moodit.core_service.model.Post;

public interface PostRepository extends JpaRepository<Post, Integer> {

}
