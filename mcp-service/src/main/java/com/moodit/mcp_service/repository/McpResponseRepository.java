package com.moodit.mcp_service.repository;

import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface McpResponseRepository extends JpaRepository<McpResponse, Integer> {

    /** Historique d'un cours pour un statut donné (DONE), le plus récent d'abord. */
    List<McpResponse> findByCourse_IdAndStatusOrderByCreatedAtDesc(Integer courseId, McpStatus status);

    /** L'utilisateur a-t-il une analyse à ce statut (PENDING) sur ce cours ? (verrou / réhydratation) */
    boolean existsByCourse_IdAndUser_IdAndStatus(Integer courseId, Integer userId, McpStatus status);
}
