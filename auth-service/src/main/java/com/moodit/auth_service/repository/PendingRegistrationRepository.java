// Accès JPA aux inscriptions en attente de vérification + purge des codes expirés.

package com.moodit.auth_service.repository;

import com.moodit.auth_service.model.PendingRegistration;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.Optional;

@Repository
public interface PendingRegistrationRepository extends JpaRepository<PendingRegistration, Integer> {

  Optional<PendingRegistration> findByEmail(String email);

  Optional<PendingRegistration> findByUsername(String username);

  boolean existsByEmail(String email);

  boolean existsByUsername(String username);

  @Modifying
  @Query("DELETE FROM PendingRegistration p WHERE p.verificationCodeExpiresAt < :now")
  int deleteExpired(@Param("now") LocalDateTime now);
}
