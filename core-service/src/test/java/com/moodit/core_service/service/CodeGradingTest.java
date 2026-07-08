package com.moodit.core_service.service;

import com.moodit.core_service.dto.QuestionResultDTO;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.TestCase;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Notation d'une question Code : score DÉCIMAL au dixième près = total × (poids réussis / poids
 * total). Vérifie l'arrondi, le crédit partiel pondéré, les bornes, et l'état « en cours ».
 */
class CodeGradingTest {

    private Question question(int id, double total) {
        Question q = new Question();
        q.setId(id);
        q.setTotalScore(total);
        return q;
    }

    private TestCase harness(int id, int weight) {
        TestCase t = new TestCase();
        t.setId(id);
        t.setName("h" + id);
        t.setWeight(weight);
        return t;
    }

    @Test
    void decimal_score_rounded_to_one_decimal() {
        // 2.5 pts, 2 harnais réussis sur 3 (poids égaux) → 2.5 × 2/3 = 1.666… → 1.7
        QuestionResultDTO r = CodeGrading.build(
                question(1, 2.5),
                List.of(harness(10, 1), harness(11, 1), harness(12, 1)),
                Map.of(10, true, 11, true, 12, false));
        assertThat(r.getEarned()).isEqualTo(1.7);
        assertThat(r.getMax()).isEqualTo(2.5);
    }

    @Test
    void weighted_partial_credit() {
        // 5.0 pts, poids 3 réussi + poids 1 échoué → 5 × 3/4 = 3.75 → 3.8
        QuestionResultDTO r = CodeGrading.build(
                question(1, 5.0),
                List.of(harness(10, 3), harness(11, 1)),
                Map.of(10, true, 11, false));
        assertThat(r.getEarned()).isEqualTo(3.8);
    }

    @Test
    void all_passed_earns_full_score() {
        QuestionResultDTO r = CodeGrading.build(
                question(1, 3.0),
                List.of(harness(10, 2), harness(11, 1)),
                Map.of(10, true, 11, true));
        assertThat(r.getEarned()).isEqualTo(3.0);
    }

    @Test
    void none_passed_earns_zero() {
        QuestionResultDTO r = CodeGrading.build(
                question(1, 4.0),
                List.of(harness(10, 1), harness(11, 1)),
                Map.of(10, false, 11, false));
        assertThat(r.getEarned()).isEqualTo(0.0);
    }

    @Test
    void empty_harnesses_is_pending() {
        QuestionResultDTO r = CodeGrading.build(question(1, 2.0), List.of(), Map.of());
        assertThat(r.getEarned()).isEqualTo(0.0);
        assertThat(r.getMax()).isEqualTo(2.0);
        assertThat(r.getTests()).isNull();   // correction async pas encore terminée
    }
}
