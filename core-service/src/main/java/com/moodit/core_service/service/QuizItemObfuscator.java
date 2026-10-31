package com.moodit.core_service.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Random;
import java.util.function.Function;

/**
 * Vue PASSATION des éléments déplaçables (Remise en ordre, Association) : identifiants publics
 * opaques et ordre d'envoi mélangé (#28), ou ordre de départ fixe pour une Remise en ordre (#211).
 *
 * <p>Les ids de {@code Drag_Item} sont séquentiels et l'éditeur crée les éléments dans l'ordre
 * attendu : exposés tels quels, trier les ids redonnait la solution. En passation, chaque id est
 * donc remplacé par une image PSEUDO-ALÉATOIRE stable ({@link #mask}) : une permutation à clé
 * (réseau de Feistel à 4 tours, fonction de tour HMAC-SHA256) de l'intervalle {@code [0, 2^30)},
 * décalée de 1 pour ne jamais produire 0. C'est une bijection : {@link #unmask} retrouve l'id réel
 * à la soumission, sans état ni collision. La clé est dérivée du jeton interne (aucun nouveau
 * secret à déployer) avec un libellé propre à cet usage.
 *
 * <p>Les ids masqués sont STABLES (même valeur à chaque chargement) : une réponse en cours reste
 * valide si l'étudiant recharge le quiz. L'ordre d'une Association est retiré au hasard à chaque
 * envoi ({@link #shuffled}). Celui d'une Remise en ordre est FIXE ({@link #fixedOrderExcept}) : un
 * seul ordre de départ par question, le même pour tous et à chaque chargement, différent de l'ordre
 * attendu. Un observateur ne voit donc jamais qu'un ordre, qui lui apprend seulement que ce n'est
 * pas la solution.
 *
 * <p>Hypothèse : {@code Drag_Item.id} (SERIAL, jusqu'à 2^31 - 1) reste sous 2^30, soit plus d'un
 * milliard d'éléments créés. Au-delà, {@link #mask} renvoie {@code null} et l'élément n'est plus
 * jouable en passation. Le domaine est pair pour garder un réseau de Feistel équilibré ; s'il
 * fallait le dépasser, passer à 32 bits, ce qui change le type des ids publics.
 */
@Component
public class QuizItemObfuscator {

    /** Domaine de la permutation : ids réels dans [0, 2^30), ids publics dans [1, 2^30]. */
    static final int DOMAIN_BITS = 30;
    private static final int HALF_BITS = DOMAIN_BITS / 2;
    private static final int HALF_MASK = (1 << HALF_BITS) - 1;
    private static final int DOMAIN_SIZE = 1 << DOMAIN_BITS;
    private static final int ROUNDS = 4;
    private static final String HMAC = "HmacSHA256";
    private static final String KEY_LABEL = "moodit/quiz/drag-item-public-id/v1";
    private static final String START_ORDER_KEY_LABEL = "moodit/quiz/ordering-start-order/v1";

    private final SecretKeySpec roundKey;
    private final SecretKeySpec startOrderKey;
    private final Random random;

    @Autowired
    public QuizItemObfuscator(@Value("${app.internal.token}") String secret) {
        this(secret, new SecureRandom());
    }

    /** Graine fixée : mélanges reproductibles (tests). */
    QuizItemObfuscator(String secret, Random random) {
        if (secret == null || secret.isBlank()) {
            throw new IllegalStateException("INTERNAL_TOKEN est vide : définir un jeton interne");
        }
        SecretKeySpec master = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC);
        this.roundKey = derivedKey(master, KEY_LABEL);
        this.startOrderKey = derivedKey(master, START_ORDER_KEY_LABEL);
        this.random = random;
    }

    /** Id public d'un élément ; {@code null} si l'id réel est absent ou hors domaine. */
    public Integer mask(Integer realId) {
        if (realId == null || realId < 0 || realId >= DOMAIN_SIZE) return null;
        Mac mac = newMac();
        int left = realId >>> HALF_BITS;
        int right = realId & HALF_MASK;
        for (int round = 0; round < ROUNDS; round++) {
            int next = left ^ roundFunction(mac, round, right);
            left = right;
            right = next;
        }
        return ((left << HALF_BITS) | right) + 1;
    }

    /** Id réel correspondant à un id public ; {@code null} si absent ou hors domaine. */
    public Integer unmask(Integer publicId) {
        if (publicId == null || publicId < 1 || publicId > DOMAIN_SIZE) return null;
        Mac mac = newMac();
        int value = publicId - 1;
        int left = value >>> HALF_BITS;
        int right = value & HALF_MASK;
        for (int round = ROUNDS - 1; round >= 0; round--) {
            int previous = right ^ roundFunction(mac, round, left);
            right = left;
            left = previous;
        }
        return (left << HALF_BITS) | right;
    }

    /** Copie mélangée de la liste (ordre d'envoi à l'étudiant, nouveau tirage à chaque appel). */
    public <T> List<T> shuffled(List<T> items) {
        List<T> copy = new ArrayList<>(items);
        synchronized (random) {
            Collections.shuffle(copy, random);
        }
        return copy;
    }

    /**
     * Ordre de départ FIXE d'une Remise en ordre : toujours le même pour une question et ses
     * éléments (aucun tirage, aucun stockage), et jamais l'ordre {@code avoided} (l'ordre attendu),
     * pour que la question ne s'ouvre pas déjà résolue.
     *
     * <p>Les candidats sont des permutations de Fisher-Yates dont chaque tirage est un HMAC (clé
     * propre à cet usage) de l'id de la question, des ids de ses éléments, du numéro du candidat et
     * de la position. On garde le premier candidat différent de {@code avoided} : le résultat est
     * uniforme sur les autres ordres et ne dépend de l'ordre attendu que par cette exclusion.
     * Modifier les éléments change leurs ids, donc l'ordre de départ.
     *
     * <p>Les ordres sont comparés par {@code key} (l'id d'un élément : les entités se référencent
     * entre elles, leurs equals/hashCode ne sont pas utilisables). Les clés sont non nulles et
     * distinctes ; moins de deux : aucun autre ordre possible, la liste est rendue telle quelle.
     */
    public <T> List<T> fixedOrderExcept(int scopeId, List<T> items, List<T> avoided, Function<T, Integer> key) {
        // Point de départ canonique (tri par clé) : l'ordre de la base n'influe pas sur le résultat.
        List<T> canonical = items.stream().sorted(Comparator.comparing(key)).toList();
        if (canonical.size() < 2) return canonical;
        List<Integer> avoidedKeys = avoided.stream().map(key).toList();
        ByteBuffer seed = ByteBuffer.allocate(Integer.BYTES * (canonical.size() + 4));
        seed.putInt(scopeId).putInt(canonical.size());
        canonical.forEach(item -> seed.putInt(key.apply(item)));
        Mac mac = newMac(startOrderKey);
        // Chaque candidat est uniforme sur les n! ordres : au plus une chance sur deux de retomber
        // sur l'ordre évité, la boucle s'arrête presque aussitôt.
        for (int candidate = 0; ; candidate++) {
            List<T> order = permutation(mac, seed, candidate, canonical);
            if (!order.stream().map(key).toList().equals(avoidedKeys)) return order;
        }
    }

    /** Candidat n° {@code candidate} : Fisher-Yates dont chaque tirage est un HMAC de la graine. */
    private static <T> List<T> permutation(Mac mac, ByteBuffer seed, int candidate, List<T> canonical) {
        List<T> order = new ArrayList<>(canonical);
        for (int i = order.size() - 1; i > 0; i--) {
            seed.putInt(seed.capacity() - 2 * Integer.BYTES, candidate).putInt(seed.capacity() - Integer.BYTES, i);
            long draw = ByteBuffer.wrap(mac.doFinal(seed.array())).getLong();
            // Biais du modulo négligeable : 2^64 tirages pour au plus quelques dizaines de positions.
            Collections.swap(order, i, (int) Long.remainderUnsigned(draw, i + 1));
        }
        return order;
    }

    private int roundFunction(Mac mac, int round, int half) {
        byte[] out = mac.doFinal(new byte[] {(byte) round, (byte) (half >>> 8), (byte) half});
        return ((out[0] & 0xFF) << 8 | (out[1] & 0xFF)) & HALF_MASK;
    }

    /** Sous-clé propre à un usage : HMAC du libellé sous le secret maître. */
    private static SecretKeySpec derivedKey(SecretKeySpec master, String label) {
        return new SecretKeySpec(newMac(master).doFinal(label.getBytes(StandardCharsets.UTF_8)), HMAC);
    }

    private Mac newMac() {
        return newMac(roundKey);
    }

    private static Mac newMac(SecretKeySpec key) {
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(key);
            return mac;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HMAC-SHA256 indisponible", e);
        }
    }
}
