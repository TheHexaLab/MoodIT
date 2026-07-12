package com.moodit.core_service.repository;

import com.moodit.core_service.model.AuditLog;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

/**
 * Journal d'audit. La lecture paginée/filtrée passe par {@link AuditLogRepositoryCustom#search}
 * (requête Criteria dynamique → prédicats sargables, cf. les index GIN trigram d'init.sql).
 */
@Repository
public interface AuditLogRepository
        extends JpaRepository<AuditLog, Integer>, AuditLogRepositoryCustom {}
