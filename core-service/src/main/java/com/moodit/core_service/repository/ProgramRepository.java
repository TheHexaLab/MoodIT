package com.moodit.core_service.repository;
import com.moodit.core_service.model.Program;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.List;

@Repository
public interface ProgramRepository extends JpaRepository<Program, Integer> {

    List<Program> findByEstablishmentId(Integer establishmentId);
}
