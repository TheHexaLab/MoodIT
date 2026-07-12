package com.moodit.mcp_service.repository;

import com.moodit.mcp_service.model.AuditLog;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

/** Écriture seule côté mcp-service (la lecture est exposée par le core, réservée au Gardien). */
@Repository
public interface AuditLogRepository extends JpaRepository<AuditLog, Integer> {}
