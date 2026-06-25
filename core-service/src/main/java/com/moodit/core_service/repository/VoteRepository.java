package com.moodit.core_service.repository;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.Vote;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface VoteRepository extends JpaRepository<Vote, Integer> {
    Optional<Vote> findByUserIdAndPostId(Integer userId, Integer postId);
}
