package com.moodit.core_service.repository;

import com.moodit.core_service.model.FType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface FTypeRepository extends JpaRepository<FType, Integer> {
    Optional<FType> findByName(String name);
}
