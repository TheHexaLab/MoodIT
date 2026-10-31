package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.IntStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Ids publics des éléments déplaçables (#28) : bijection à clé, stable ; mélange et ordre de départ fixe (#211). */
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

    @Test
    @DisplayName("fixedOrderExcept : même ordre à chaque appel, pour toute instance de même secret")
    void fixedOrder_deterministe() {
        List<Integer> items = List.of(10, 11, 12, 13, 14);
        List<Integer> first = obfuscator.fixedOrderExcept(7, items, items, Function.identity());
        assertThat(first).containsExactlyInAnyOrderElementsOf(items).isNotEqualTo(items);
        for (int i = 0; i < 20; i++) {
            assertThat(obfuscator.fixedOrderExcept(7, items, items, Function.identity())).isEqualTo(first);
        }
        // Autre instance (autre générateur aléatoire), même secret : même ordre, sans état partagé.
        assertThat(new QuizItemObfuscator("test-secret", new Random(99))
                .fixedOrderExcept(7, items, items, Function.identity())).isEqualTo(first);
        assertThat(items).containsExactly(10, 11, 12, 13, 14); // liste d'origine intacte
    }

    @Test
    @DisplayName("fixedOrderExcept : l'ordre des éléments en entrée (ordre de la base) n'influe pas")
    void fixedOrder_independantDeLOrdreDEntree() {
        List<Integer> items = List.of(10, 11, 12, 13);
        List<Integer> avoided = List.of(13, 12, 11, 10);
        assertThat(obfuscator.fixedOrderExcept(7, List.of(12, 10, 13, 11), avoided, Function.identity()))
                .isEqualTo(obfuscator.fixedOrderExcept(7, items, avoided, Function.identity()));
    }

    @Test
    @DisplayName("fixedOrderExcept : la question, les ids des éléments et le secret font varier l'ordre")
    void fixedOrder_varieSelonQuestionElementsEtSecret() {
        List<Integer> items = List.of(10, 11, 12, 13, 14);
        List<Integer> replaced = List.of(10, 11, 12, 13, 15); // un élément remplacé → nouvel id
        QuizItemObfuscator other = new QuizItemObfuscator("autre-secret", new Random(28));
        Set<List<Integer>> byQuestion = new HashSet<>();
        int changedByItems = 0;
        int changedBySecret = 0;
        for (int scope = 0; scope < 30; scope++) {
            List<Integer> order = obfuscator.fixedOrderExcept(scope, items, items, Function.identity());
            byQuestion.add(order);
            // Rang de chaque élément gardé : comparable d'une version des éléments à l'autre.
            List<Integer> keptRanks = obfuscator.fixedOrderExcept(scope, replaced, replaced, Function.identity())
                    .stream().map(id -> id == 15 ? 14 : id).toList();
            if (!keptRanks.equals(order)) changedByItems++;
            if (!other.fixedOrderExcept(scope, items, items, Function.identity()).equals(order)) changedBySecret++;
        }
        assertThat(byQuestion).hasSizeGreaterThan(20); // 119 ordres possibles
        assertThat(changedByItems).isGreaterThan(20);
        assertThat(changedBySecret).isGreaterThan(20);
    }

    @Test
    @DisplayName("fixedOrderExcept : jamais l'ordre évité ; uniforme sur les autres ordres d'une question à l'autre")
    void fixedOrder_eviteLOrdre() {
        // Deux éléments : un seul autre ordre, atteint quelle que soit la question.
        List<Integer> two = List.of(1, 2);
        for (int scope = 0; scope < 100; scope++) {
            assertThat(obfuscator.fixedOrderExcept(scope, two, two, Function.identity())).containsExactly(2, 1);
        }
        List<Integer> three = List.of(1, 2, 3);
        Map<List<Integer>, Integer> counts = new HashMap<>();
        for (int scope = 0; scope < 1500; scope++) {
            counts.merge(obfuscator.fixedOrderExcept(scope, three, three, Function.identity()), 1, Integer::sum);
        }
        // 3! - 1 = 5 ordres, ≈ 300 chacun ; tolérance large (test déterministe, secret fixé).
        assertThat(counts).hasSize(5).doesNotContainKey(three);
        assertThat(counts.values()).allSatisfy(c -> assertThat(c).isBetween(220, 380));
    }

    @Test
    @DisplayName("fixedOrderExcept : l'ordre évité ne sert qu'à l'exclusion (même ordre pour deux solutions, presque toujours)")
    void fixedOrder_nEncodePasLOrdreEvite() {
        List<Integer> items = List.of(1, 2, 3, 4);
        List<Integer> otherAvoided = List.of(4, 3, 2, 1);
        int same = 0;
        for (int scope = 0; scope < 240; scope++) {
            List<Integer> a = obfuscator.fixedOrderExcept(scope, items, items, Function.identity());
            List<Integer> b = obfuscator.fixedOrderExcept(scope, items, otherAvoided, Function.identity());
            if (a.equals(b)) same++;
        }
        // Différents seulement si le premier candidat est l'un des deux ordres évités (≈ 2 sur 24).
        assertThat(same).isGreaterThan(200);
    }

    @Test
    @DisplayName("fixedOrderExcept : comparaison par la clé fournie, pas par equals des éléments")
    void fixedOrder_parCle() {
        // Deux éléments égaux au sens d'equals mais de clés distinctes : l'ordre évité reste évité.
        record Item(int id) {
            @Override public boolean equals(Object o) { return o instanceof Item; }
            @Override public int hashCode() { return 0; }
        }
        List<Item> items = List.of(new Item(1), new Item(2));
        for (int scope = 0; scope < 50; scope++) {
            assertThat(obfuscator.fixedOrderExcept(scope, items, items, Item::id))
                    .extracting(Item::id).containsExactly(2, 1);
        }
    }

    @Test
    @DisplayName("fixedOrderExcept : moins de deux éléments → rendu tel quel, sans boucle infinie")
    void fixedOrder_sansAutreOrdrePossible() {
        assertThat(obfuscator.fixedOrderExcept(1, List.<Integer>of(), List.of(), Function.identity())).isEmpty();
        assertThat(obfuscator.fixedOrderExcept(1, List.of(7), List.of(7), Function.identity())).containsExactly(7);
    }
}
