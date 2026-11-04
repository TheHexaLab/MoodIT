package com.moodit.execution_service.dto;

import tools.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Un CAS de test STRUCTURÉ pour une question « appel de fonction » (#116). Contrairement à un
 * harnais-code (arbitraire, qui finit dans le sandbox et expose les attendus), un cas décrit juste :
 * appeler {@code entry(args…)} et comparer la valeur de retour à {@code expected} selon {@code compare}.
 *
 * <p>SÉCURITÉ : {@code expected} n'est JAMAIS envoyé dans le sandbox. {@code execution-service} lance
 * le code étudiant comme un SERVEUR RPC (sans harnais, sans nonce), lui envoie {@code entry(args)},
 * reçoit la sortie, puis compare LUI-MÊME à {@code expected}. Le verdict et les attendus restent donc
 * hors de portée de l'étudiant, quel que soit le langage.
 *
 * <p>{@code args} et {@code expected} sont du JSON (primitifs, chaînes, tableaux de ceux-ci —
 * périmètre marshalable, cf. CodeAssembler). {@code compare} : {@code exact} (défaut),
 * {@code float} (tolérance), {@code unordered} (collection sans ordre).
 */
public record StructuredCase(
        @NotBlank @Size(max = 500) String name,
        @NotBlank @Size(max = 200) String entry,
        JsonNode args,
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
