package com.moodit.core_service.model;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Clé composite de {@link GradingFailure} : égalité par (quiz, étudiant), utilisée par findById. */
class GradingFailureTest {

    @Test
    @DisplayName("Clé : égale et même hash pour le même (quiz, étudiant), différente sinon")
    void cle_egalite() {
        GradingFailure.Key key = new GradingFailure.Key(4, 3);
        assertThat(key).isEqualTo(new GradingFailure.Key(4, 3))
                .hasSameHashCodeAs(new GradingFailure.Key(4, 3))
                .isNotEqualTo(new GradingFailure.Key(4, 5))
                .isNotEqualTo(new GradingFailure.Key(5, 3))
                .isNotEqualTo("4-3");
        // Constructeur sans argument exigé par JPA pour une @IdClass.
        assertThat(new GradingFailure.Key()).isEqualTo(new GradingFailure.Key(null, null));
    }
}
