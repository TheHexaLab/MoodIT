package com.moodit.core_service.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.function.Function;

/**
 * Vue PASSATION des éléments déplaçables (Remise en ordre, Association) : identifiants publics
 * opaques et ordre d'envoi mélangé (#28).
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
 * valide si l'étudiant recharge le quiz. L'ordre, lui, est retiré au hasard à chaque envoi.
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

    private final SecretKeySpec roundKey;
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
        byte[] derived = newMac(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC))
                .doFinal(KEY_LABEL.getBytes(StandardCharsets.UTF_8));
        this.roundKey = new SecretKeySpec(derived, HMAC);
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
     * Comme {@link #shuffled}, mais jamais dans l'ordre {@code avoided} : une Remise en ordre ne
     * s'ouvre pas déjà résolue. Les ordres sont comparés par {@code key} (l'id d'un élément : les
     * entités se référencent entre elles, leurs equals/hashCode ne sont pas utilisables). Moins de
     * deux clés distinctes : aucun autre ordre possible, la liste est rendue mélangée sans contrainte.
     */
    public <T, K> List<T> shuffledExcept(List<T> items, List<T> avoided, Function<T, K> key) {
        List<K> avoidedKeys = avoided.stream().map(key).toList();
        List<T> copy = shuffled(items);
        if (new HashSet<>(avoidedKeys).size() < 2) return copy;
        while (copy.stream().map(key).toList().equals(avoidedKeys)) {
            copy = shuffled(items);
        }
        return copy;
    }

    private int roundFunction(Mac mac, int round, int half) {
        byte[] out = mac.doFinal(new byte[] {(byte) round, (byte) (half >>> 8), (byte) half});
        return ((out[0] & 0xFF) << 8 | (out[1] & 0xFF)) & HALF_MASK;
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
