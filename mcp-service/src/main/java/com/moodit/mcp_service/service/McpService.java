package com.moodit.mcp_service.service;

import tools.jackson.databind.ObjectMapper;
import com.moodit.mcp_service.dto.Author;
import com.moodit.mcp_service.dto.McpAnalysis;
import com.moodit.mcp_service.dto.McpResponseDto;
import com.moodit.mcp_service.dto.McpResponseSummaryDto;
import com.moodit.mcp_service.exception.AnalysisAlreadyRunningException;
import com.moodit.mcp_service.exception.AnalysisNotFoundException;
import com.moodit.mcp_service.exception.CourseNotFoundException;
import com.moodit.mcp_service.exception.ForbiddenException;
import com.moodit.mcp_service.exception.UserNotFoundException;
import com.moodit.mcp_service.model.Course;
import com.moodit.mcp_service.model.McpResponse;
import com.moodit.mcp_service.model.McpStatus;
import com.moodit.mcp_service.model.User;
import com.moodit.mcp_service.repository.CourseRepository;
import com.moodit.mcp_service.repository.McpResponseRepository;
import com.moodit.mcp_service.repository.UserRepository;
import com.moodit.mcp_service.service.mcp.McpAnalysisRunner;
import com.moodit.mcp_service.util.Timestamps;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;

/**
 * Feedback MCP d'un cours (analyse LLM). Réservé aux administrateurs (403 sinon).
 * Déclenchement ASYNCHRONE : {@link #requestAnalysis} crée une ligne `pending` et rend la
 * main (le contrôleur répond 202) ; le job ({@link McpAnalysisRunner}) produit le résultat
 * et le POUSSE par WebSocket (via core-service). Le verrou « une analyse en cours par
 * (cours, user) » est garanti par l'index unique partiel (cf. init.sql).
 */
@Service
@RequiredArgsConstructor
public class McpService {

    private final McpResponseRepository mcpResponseRepository;
    private final CourseRepository courseRepository;
    private final UserRepository userRepository;
    private final ObjectMapper objectMapper;
    private final McpAnalysisRunner analysisRunner;

    /** Historique (résumés) des analyses TERMINÉES d'un cours, récent → ancien. */
    @Transactional(readOnly = true)
    public List<McpResponseSummaryDto> listAnalyses(Integer courseId, String userEmail) {
        requireAdmin(userEmail);
        return mcpResponseRepository
                .findByCourse_IdAndStatusOrderByCreatedAtDesc(courseId, McpStatus.DONE)
                .stream()
                .map(this::toSummary)
                .toList();
    }

    /** Détail complet d'une analyse (avec content + author). */
    @Transactional(readOnly = true)
    public McpResponseDto getAnalysis(Integer id, String userEmail) {
        requireAdmin(userEmail);
        McpResponse response = mcpResponseRepository.findById(id)
                .orElseThrow(AnalysisNotFoundException::new);
        User author = response.getUser();
        return new McpResponseDto(
                response.getId(),
                Timestamps.isoUtc(response.getCreatedAt()),
                response.getContent(),
                author.getId(),
                response.getCourse().getId(),
                new Author(author.getId(), author.getUsername(), author.getFirstName(),
                        author.getLastName(), author.getAvatarColor()));
    }

    /** L'utilisateur courant a-t-il une analyse EN COURS sur ce cours ? (réhydratation) */
    @Transactional(readOnly = true)
    public boolean isPending(Integer courseId, String userEmail) {
        User user = requireAdmin(userEmail);
        return mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(
                courseId, user.getId(), McpStatus.PENDING);
    }

    /**
     * Déclenche une analyse : crée la ligne `pending` puis lance le job APRÈS commit (sinon
     * le thread async ne verrait pas la ligne). 409 si une analyse est déjà en cours pour
     * (cours, user) — pré-check + secours atomique via l'index unique partiel.
     */
    @Transactional
    public void requestAnalysis(Integer courseId, String userEmail) {
        User user = requireAdmin(userEmail);
        Course course = courseRepository.findById(courseId)
                .orElseThrow(CourseNotFoundException::new);

        if (mcpResponseRepository.existsByCourse_IdAndUser_IdAndStatus(
                courseId, user.getId(), McpStatus.PENDING)) {
            throw new AnalysisAlreadyRunningException();
        }

        McpResponse pending = new McpResponse();
        pending.setCourse(course);
        pending.setUser(user);
        pending.setStatus(McpStatus.PENDING);
        McpResponse saved;
        try {
            saved = mcpResponseRepository.saveAndFlush(pending);
        } catch (DataIntegrityViolationException e) {
            // POST concurrent : l'index unique partiel a tranché.
            throw new AnalysisAlreadyRunningException();
        }

        Integer responseId = saved.getId();
        afterCommit(() -> analysisRunner.run(responseId));
    }

    // ── Interne ──────────────────────────────────────────────────────────────

    /** Projette une analyse terminée en résumé (compteurs dérivés du content JSON). */
    private McpResponseSummaryDto toSummary(McpResponse response) {
        int strengths = 0;
        int improvements = 0;
        if (response.getContent() != null && !response.getContent().isBlank()) {
            try {
                McpAnalysis analysis = objectMapper.readValue(response.getContent(), McpAnalysis.class);
                strengths = analysis.strengths() == null ? 0 : analysis.strengths().size();
                improvements = analysis.improvements() == null ? 0 : analysis.improvements().size();
            } catch (Exception ignored) {
                // content illisible → compteurs à 0 (l'entrée reste listée)
            }
        }
        return new McpResponseSummaryDto(
                response.getId(), Timestamps.isoUtc(response.getCreatedAt()), strengths, improvements);
    }

    /** Exige le rôle « Administrateur » ; renvoie l'utilisateur résolu. 403 sinon. */
    private User requireAdmin(String userEmail) {
        User user = userRepository.findByEmail(userEmail)
                .orElseThrow(UserNotFoundException::new);
        boolean admin = user.getRoles() != null && user.getRoles().stream()
                .anyMatch(r -> "Administrateur".equals(r.getName()));
        if (!admin) throw new ForbiddenException();
        return user;
    }

    /** Exécute l'action APRÈS commit (ou tout de suite hors transaction). */
    private void afterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    action.run();
                }
            });
        } else {
            action.run();
        }
    }
}
