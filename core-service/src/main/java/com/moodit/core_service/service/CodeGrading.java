package com.moodit.core_service.service;

import com.moodit.core_service.dto.CodingTestResultDTO;
import com.moodit.core_service.dto.QuestionResultDTO;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.TestCase;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Notation d'une question Code à partir des verdicts par harnais. Partagé entre le job de
 * correction (verdicts frais) et la lecture d'un résultat (verdicts persistés en base). Le score
 * gagné = score total × (somme des poids réussis / somme des poids). Sans verdict → « en cours »
 * (tests = null), le job async n'ayant pas encore répondu.
 */
final class CodeGrading {

    private CodeGrading() {}

    /** Résultat « en cours » d'une question Code (correction async pas encore terminée). */
    static QuestionResultDTO pending(Question question) {
        return pending(question, null);
    }

    /** Idem, en conservant le code soumis (affiché en révision même avant les verdicts). */
    static QuestionResultDTO pending(Question question, String submittedCode) {
        return QuestionResultDTO.builder()
                .questionId(question.getId())
                .earned(0.0)
                .max(question.getTotalScore())
                .submittedCode(submittedCode)
                .tests(null)
                .build();
    }

    /**
     * Résultat corrigé : {@code passedByTestCaseId} = verdict (true/false) par id de Test_Case.
     * Les harnais absents de la map comptent comme non réussis. Vide → « en cours ».
     */
    static QuestionResultDTO build(
            Question question, List<TestCase> harnesses, Map<Integer, Boolean> passedByTestCaseId,
            String submittedCode) {
        if (harnesses.isEmpty() || passedByTestCaseId.isEmpty()) {
            return pending(question, submittedCode);
        }
        int totalWeight = 0;
        int passedWeight = 0;
        List<Object> tests = new ArrayList<>();
        for (TestCase tc : harnesses) {
            int weight = tc.getWeight() != null && tc.getWeight() > 0 ? tc.getWeight() : 1;
            boolean passed = Boolean.TRUE.equals(passedByTestCaseId.get(tc.getId()));
            totalWeight += weight;
            if (passed) passedWeight += weight;
            tests.add(new CodingTestResultDTO(tc.getName(), passed, weight));
        }
        double total = question.getTotalScore() != null ? question.getTotalScore() : 0.0;
        // Score au dixième près : total × (poids réussis / poids total).
        double earned = totalWeight == 0 ? 0.0 : Math.round(total * passedWeight / totalWeight * 10.0) / 10.0;
        return QuestionResultDTO.builder()
                .questionId(question.getId())
                .earned(earned)
                .max(question.getTotalScore())
                .submittedCode(submittedCode)
                .tests(tests)
                .build();
    }
}
