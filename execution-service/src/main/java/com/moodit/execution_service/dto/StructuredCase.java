package com.moodit.execution_service.dto;

import tools.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Un CAS de test STRUCTURÉ (#116). Contrairement à un harnais-code (arbitraire, qui finit dans le
 * sandbox et expose les attendus), un cas décrit une EXPRESSION qui RENVOIE la valeur testée — appel
 * de fonction, construction d'objet + méthode, séquence : n'importe quoi de value-producing dans le
 * langage de la question — et l'ATTENDU auquel la comparer selon {@code compare}.
 *
 * <p>SÉCURITÉ : {@code expected} n'est JAMAIS envoyé dans le sandbox. {@code execution-service} lance
 * le code étudiant comme un SERVEUR qui ÉVALUE {@code expr} et émet la valeur ; il compare LUI-MÊME à
 * {@code expected}. Le verdict et les attendus restent donc hors de portée de l'étudiant (l'expression,
 * donc les entrées, y est visible — mais une entrée est de toute façon connue du code qui la reçoit).
 *
 * <p>{@code expected} est du JSON (scalaire : nombre, booléen, chaîne). {@code compare} :
 * {@code exact} (défaut), {@code unordered} (collection sans ordre), les relationnels
 * {@code gt}/{@code ge}/{@code lt}/{@code le} (l'attendu est la borne, comparée hors sandbox),
 * {@code ne} (différent), {@code contains}/{@code regex} (sur chaîne) et {@code compound}
 * (combinaison ET/OU). Une marge de tolérance s'exprime en composant une plage ({@code ge a} ET
 * {@code le b}). Un mode inconnu retombe sur {@code exact}.
 */
public record StructuredCase(
        @NotBlank @Size(max = 500) String name,
        @NotBlank @Size(max = 10_000) String expr,
        JsonNode expected,
        String compare,
        Integer weight) {

    /** Poids effectif : ≥ 1 (défaut 1 si absent/invalide). */
    public int effectiveWeight() {
        return weight != null && weight > 0 ? weight : 1;
    }

    /** Mode de comparaison normalisé (défaut {@code exact}). */
    public String compareMode() {
        return compare == null || compare.isBlank() ? "exact" : compare.trim().toLowerCase(java.util.Locale.ROOT);
    }
}
