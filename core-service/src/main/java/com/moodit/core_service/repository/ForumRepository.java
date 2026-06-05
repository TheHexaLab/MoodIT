package com.moodit.core_service.repository;

//Model
import com.moodit.core_service.model.Forum;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface ForumRepository extends JpaRepository<Forum, Integer> {


}
