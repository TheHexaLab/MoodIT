package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;
import java.util.stream.IntStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Ids publics des éléments déplaçables (#28) : bijection à clé, stable, et mélange. */
class QuizItemObfuscatorTest {

    private static final int DOMAIN = 1 << QuizItemObfuscator.DOMAIN_BITS;
    private final QuizItemObfuscator obfuscator = new QuizItemObfuscator("test-secret", new Random(28));

    @Test
    @DisplayName("unmask(mask(id)) = id, y compris aux bornes du domaine ; id public jamais 0")
    void allerRetour() {
        List<Integer> ids = List.of(0, 1, 2, 100, 101, 65_535, 123_456_789, DOMAIN - 1);
        for (Integer id : ids) {
            Integer pub = obfuscator.mask(id);
            assertThat(pub).isBetween(1, DOMAIN);
            assertThat(obfuscator.unmask(pub)).isEqualTo(id);
        }
    }

    @Test
    @DisplayName("Ids consécutifs → ids publics tous distincts et non consécutifs")
    void idsConsecutifs_decorreles() {
        Set<Integer> seen = new HashSet<>();
        int ascending = 0;
        Integer previous = null;
        for (int id = 1000; id < 1200; id++) {
            Integer pub = obfuscator.mask(id);
            assertThat(seen.add(pub)).isTrue();
            if (previous != null && pub > previous) ascending++;
            previous = pub;
        }
        // Une suite croissante donnerait 199 ; un tirage indépendant ≈ 100.
        assertThat(ascending).isBetween(70, 130);
    }

    @Test
    @DisplayName("Hors domaine ou null → null (mask comme unmask)")
    void horsDomaine_null() {
        assertThat(obfuscator.mask(null)).isNull();
        assertThat(obfuscator.mask(-1)).isNull();
        assertThat(obfuscator.mask(DOMAIN)).isNull();
        assertThat(obfuscator.unmask(null)).isNull();
        assertThat(obfuscator.unmask(0)).isNull();
        assertThat(obfuscator.unmask(-5)).isNull();
        assertThat(obfuscator.unmask(DOMAIN + 1)).isNull();
        assertThat(obfuscator.unmask(DOMAIN)).isNotNull();
    }

    @Test
    @DisplayName("La clé détermine la permutation : autre secret → autres ids publics")
    void cleDifferente_autresIds() {
        QuizItemObfuscator other = new QuizItemObfuscator("autre-secret", new Random(28));
        long same = IntStream.range(0, 50).filter(id -> obfuscator.mask(id).equals(other.mask(id))).count();
        assertThat(same).isZero();
        assertThat(new QuizItemObfuscator("test-secret").mask(42)).isEqualTo(obfuscator.mask(42));
    }

    @Test
    @DisplayName("Secret vide ou absent → démarrage refusé")
    void secretVide_refuse() {
        assertThatThrownBy(() -> new QuizItemObfuscator(" ")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new QuizItemObfuscator(null, new Random()))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("shuffled : copie (liste d'origine intacte), mêmes éléments, ordres variés")
    void shuffled_copieMelangee() {
        List<Integer> items = List.of(1, 2, 3, 4, 5, 6);
        Set<List<Integer>> orders = new HashSet<>();
        for (int i = 0; i < 50; i++) {
            List<Integer> s = obfuscator.shuffled(items);
            assertThat(s).containsExactlyInAnyOrderElementsOf(items);
            orders.add(s);
        }
        assertThat(items).containsExactly(1, 2, 3, 4, 5, 6);
        assertThat(orders).hasSizeGreaterThan(30);
    }
}
