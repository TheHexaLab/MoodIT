package com.moodit.mcp_service.util;

import java.util.regex.Pattern;

/**
 * Anonymisation CONSERVATRICE des extraits de messages de forum AVANT envoi au LLM externe.
 * On caviarde uniquement le PII à haut risque et à motif fiable — courriels, liens, @mentions,
 * numéros longs (téléphone, matricule) — sans jamais toucher à l'opinion : le ressenti d'un
 * message (« cours trop rapide, mal expliqué ») survit intact. On NE tente PAS de détecter les
 * noms/prénoms : aucun motif fiable en français, et une heuristique « mots capitalisés »
 * abîmerait le texte légitime (débuts de phrase, noms de technos…). Le prénom résiduel est un
 * risque assumé (cf. discussion RGPD / choix Groq vs Ollama local).
 *
 * <p>Appliqué au texte DÉJÀ tronqué (LEFT(content, N) en base) : un PII coupé pile à la limite
 * peut laisser un fragment non identifiant — risque négligeable et accepté.
 */
public final class ForumTextRedactor {

    private ForumTextRedactor() {}

    // Courriel d'abord (contient un @, à retirer avant les @mentions).
    private static final Pattern EMAIL = Pattern.compile("[\\w.+-]+@[\\w-]+\\.[\\w.-]+");
    // Liens http(s):// et www. …
    private static final Pattern URL = Pattern.compile("(?i)\\b(?:https?://|www\\.)\\S+");
    // @mentions (le local-part des courriels a déjà été retiré au-dessus).
    private static final Pattern MENTION = Pattern.compile("@\\w+");
    // Numéros longs (téléphone, matricule) : 7+ chiffres, séparateurs espace/point/tiret admis.
    // Épargne les petits nombres légitimes (note 8/10, 70 %) qui n'atteignent pas le seuil.
    private static final Pattern LONG_NUMBER = Pattern.compile("\\+?\\d(?:[\\d .\\-]{5,})\\d");

    /** Retourne le message avec le PII à haut risque remplacé par des jetons neutres. */
    public static String redact(String message) {
        if (message == null || message.isBlank()) {
            return message;
        }
        String out = EMAIL.matcher(message).replaceAll("[courriel]");
        out = URL.matcher(out).replaceAll("[lien]");
        out = MENTION.matcher(out).replaceAll("[mention]");
        out = LONG_NUMBER.matcher(out).replaceAll("[numéro]");
        return out;
    }
}
