package com.moodit.core_service.internal;

import com.moodit.core_service.dto.CourseQuizStatsDTO;
import com.moodit.core_service.service.QuizService;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Endpoint INTERNE (service à service) : agrégat de réussite aux quiz d'un cours, calculé à la
 * volée par {@link QuizService} (aucune note stockée). Hors préfixe /api (cf. WebMvcConfig) et
 * NON routé par le gateway → inatteignable de l'extérieur ; authentifié en plus par le jeton
 * partagé {@code X-Internal-Token} (= {@code app.internal.token}). Appelé par mcp-service.
 */
@RestController
@RequestMapping("/internal/quiz-stats")
@RequiredArgsConstructor
public class InternalQuizController {

    private final QuizService quizService;

    @Value("${app.internal.token:}")
    private String internalToken;

    @GetMapping("/course/{courseId}")
    public ResponseEntity<CourseQuizStatsDTO> courseStats(
            @RequestHeader(value = "X-Internal-Token", required = false) String token,
            @PathVariable Integer courseId) {
        if (unauthorized(token)) return ResponseEntity.status(403).build();
        return ResponseEntity.ok(quizService.getCourseQuizStats(courseId));
    }

    /** Jeton partagé requis dès qu'il est configuré (vide → contrôle désactivé). */
    private boolean unauthorized(String token) {
        return internalToken != null && !internalToken.isBlank() && !internalToken.equals(token);
    }
}
