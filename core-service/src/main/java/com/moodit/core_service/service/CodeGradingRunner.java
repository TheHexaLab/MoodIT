package com.moodit.core_service.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.QuestionResultDTO;
import com.moodit.core_service.model.Attempt;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Submission;
import com.moodit.core_service.model.SubmissionTestCase;
import com.moodit.core_service.model.TestCase;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.AttemptRepository;
import com.moodit.core_service.repository.SubmissionTestCaseRepository;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Corrige EN ARRIÈRE-PLAN les questions Code d'une tentative : exécute chaque harnais contre la
 * soumission (via {@link ExecutionClient} → sandbox), persiste les verdicts ({@code Submission_Test_Case})
 * et POUSSE le résultat par WebSocket (room de l'utilisateur). Bean séparé : le proxy @Async ne
 * s'applique pas à un appel intra-classe. Sur échec d'exécution, la question reste « en cours ».
 */
@Component
public class CodeGradingRunner {

    private static final Logger log = LoggerFactory.getLogger(CodeGradingRunner.class);

    private final AttemptRepository attemptRepository;
    private final SubmissionTestCaseRepository submissionTestCaseRepository;
    private final ExecutionClient executionClient;
    private final RealtimeEventPublisher realtimePublisher;
    private final ObjectMapper objectMapper;

    public CodeGradingRunner(
            AttemptRepository attemptRepository,
            SubmissionTestCaseRepository submissionTestCaseRepository,
            ExecutionClient executionClient,
            RealtimeEventPublisher realtimePublisher,
            ObjectMapper objectMapper) {
        this.attemptRepository = attemptRepository;
        this.submissionTestCaseRepository = submissionTestCaseRepository;
        this.executionClient = executionClient;
        this.realtimePublisher = realtimePublisher;
        this.objectMapper = objectMapper;
    }

    @Async("codeGradingExecutor")
    @Transactional
    public void gradeAttempt(Integer attemptId) {
        Attempt attempt = attemptRepository.findById(attemptId).orElse(null);
        if (attempt == null) return;
        long userId = attempt.getUser().getId();

        List<QuestionResultDTO> results = new ArrayList<>();
        for (Submission submission : attempt.getSubmissions() == null ? List.<Submission>of() : attempt.getSubmissions()) {
            Question question = submission.getQuestion();
            if (question.getQType() == null || !"Code".equals(question.getQType().getName())) continue;

            List<TestCase> harnesses = ordered(question.getTestCases());
            if (harnesses.isEmpty()) continue;

            String language = question.getLanguage() != null ? question.getLanguage().getName() : null;
            String code = extractCode(submission.getContent());
            List<ExecutionClient.Harness> inputs = harnesses.stream()
                    .map(tc -> new ExecutionClient.Harness(tc.getName(), tc.getHarnessCode(), weight(tc)))
                    .toList();

            List<Boolean> verdicts = executionClient.evaluate(language, code, inputs);
            if (verdicts == null || verdicts.size() != harnesses.size()) {
                log.warn("Correction code impossible (question {}, tentative {}) — reste en cours.",
                        question.getId(), attemptId);
                continue;
            }

            Map<Integer, Boolean> passedByTestCaseId = new HashMap<>();
            for (int i = 0; i < harnesses.size(); i++) {
                TestCase testCase = harnesses.get(i);
                boolean passed = Boolean.TRUE.equals(verdicts.get(i));
                SubmissionTestCase verdict = new SubmissionTestCase();
                verdict.setSubmission(submission);
                verdict.setTestCase(testCase);
                verdict.setPassed(passed);
                submissionTestCaseRepository.save(verdict);
                passedByTestCaseId.put(testCase.getId(), passed);
            }
            results.add(CodeGrading.build(question, harnesses, passedByTestCaseId));
        }

        if (!results.isEmpty()) {
            realtimePublisher.quizCodeGraded(userId, attempt.getId(), results);
        }
    }

    /** Extrait le code source de la réponse brute sérialisée (Submission.content JSON). */
    private String extractCode(String content) {
        if (content == null || content.isBlank()) return "";
        try {
            JsonNode node = objectMapper.readTree(content);
            return node.path("code").asText("");
        } catch (Exception e) {
            return "";
        }
    }

    private static List<TestCase> ordered(List<TestCase> testCases) {
        if (testCases == null) return List.of();
        return testCases.stream()
                .sorted(Comparator.comparing(TestCase::getId, Comparator.nullsLast(Comparator.naturalOrder())))
                .toList();
    }

    private static int weight(TestCase testCase) {
        return testCase.getWeight() != null && testCase.getWeight() > 0 ? testCase.getWeight() : 1;
    }
}
