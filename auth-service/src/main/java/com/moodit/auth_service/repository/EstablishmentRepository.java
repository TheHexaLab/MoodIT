// Accès JPA aux établissements : sert à vérifier qu'un domaine email est autorisé.

package com.moodit.auth_service.repository;

import com.moodit.auth_service.model.Establishment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface EstablishmentRepository extends JpaRepository<Establishment, Integer> {

  boolean existsByDomainEmail(String domainEmail);
}
