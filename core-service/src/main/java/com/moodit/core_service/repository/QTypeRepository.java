package com.moodit.core_service.repository;

import com.moodit.core_service.model.QType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface QTypeRepository extends JpaRepository<QType, Integer> {
    Optional<QType> findByName(String name);
}
