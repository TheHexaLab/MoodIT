package com.moodit.core_service.repository;

//Model
import com.moodit.core_service.model.Forum;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface ForumRepository extends JpaRepository<Forum, Integer> {

    /** Id du cours auquel appartient le forum (présence vocale : routage forum → cours). */
    @Query("select f.course.id from Forum f where f.id = :id")
    Optional<Integer> findCourseIdById(@Param("id") Integer id);

    /** Ids des programmes voyant ce forum (via son cours) — rooms de diffusion `program:<id>`. */
    @Query("select p.id from Forum f join f.course c join c.programs p where f.id = :id")
    List<Integer> findProgramIdsById(@Param("id") Integer id);
}
