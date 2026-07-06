package com.moodit.mcp_service.repository;

import com.moodit.mcp_service.model.User;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface UserRepository extends JpaRepository<User, Integer> {

    /** Résout l'utilisateur courant à partir de l'email injecté par le gateway. */
    Optional<User> findByEmail(String email);
}
