package com.moodit.core_service.service;

import com.moodit.core_service.model.DragItem;
import com.moodit.core_service.model.Question;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests des helpers de notation/association de QuizService :
 *  - {@code round1}/{@code scaled} : score proportionnel arrondi au dixième, borné à [0, 1] ;
 *  - {@code distinctGroups} : catégories d'une association, TRIÉES (sécurité — l'ordre affiché ne
 *    doit pas corréler avec l'ordre des items et révéler le mapping).
 */
class QuizServiceTest {

    @Test
    void round1_rounds_to_one_decimal() {
        assertThat(QuizService.round1(1.666)).isEqualTo(1.7);
        assertThat(QuizService.round1(3.75)).isEqualTo(3.8);   // demi supérieur
        assertThat(QuizService.round1(3.0)).isEqualTo(3.0);
        assertThat(QuizService.round1(0.04)).isEqualTo(0.0);
    }

    @Test
    void scaled_rounds_and_clamps_ratio() {
        assertThat(QuizService.scaled(2.5, 2.0 / 3)).isEqualTo(1.7);   // 1.666… → 1.7
        assertThat(QuizService.scaled(5.0, 1.5)).isEqualTo(5.0);       // ratio > 1 → borné à 1
        assertThat(QuizService.scaled(5.0, -0.5)).isEqualTo(0.0);      // ratio < 0 → borné à 0
        assertThat(QuizService.scaled(4.0, 0.5)).isEqualTo(2.0);
    }

    // ── distinctGroups (association) ──────────────────────────────────────────────

    private DragItem item(String group) {
        DragItem d = new DragItem();
        d.setGroupName(group);
        return d;
    }

    private Question withGroups(String... groups) {
        Question q = new Question();
        q.setDragItems(List.of(java.util.Arrays.stream(groups).map(this::item).toArray(DragItem[]::new)));
        return q;
    }

    @Test
    void distinctGroups_are_sorted_and_deduplicated() {
        // Ordre d'apparition NON alphabétique + doublon → sortie TRIÉE, sans doublon.
        // (Le tri décorrèle l'ordre affiché de l'ordre des items → pas d'indice sur la solution.)
        Question q = withGroups("Orienté objet", "Fonctionnel", "Orienté objet", "Impératif");
        assertThat(QuizService.distinctGroups(q))
                .containsExactly("Fonctionnel", "Impératif", "Orienté objet");
    }

    @Test
    void distinctGroups_ignores_null_and_blank() {
        Question q = withGroups("B", null, "  ", "A");
        assertThat(QuizService.distinctGroups(q)).containsExactly("A", "B");
    }

    @Test
    void distinctGroups_empty_when_no_drag_items() {
        assertThat(QuizService.distinctGroups(new Question())).isEmpty();
    }
}
