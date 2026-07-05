package com.moodit.mcp_service.util;

import java.time.LocalDateTime;
import java.time.ZoneOffset;

/**
 * Formatage des horodatages pour le client. La colonne mcp_response.created_at est un
 * TIMESTAMP sans fuseau, stocké en UTC (la session DB est forcée en UTC, cf.
 * application.properties). On émet donc un ISO-8601 avec suffixe « Z » : le navigateur le
 * reconvertit dans le fuseau de l'utilisateur. Sans le « Z », un LocalDateTime nu serait
 * interprété comme heure LOCALE par le front → décalage (bug observé : +4h en heure de l'Est).
 */
public final class Timestamps {

    private Timestamps() {}

    /** LocalDateTime (UTC) → ISO-8601 instant avec « Z » (ex. 2026-07-02T16:21:38.288Z). */
    public static String isoUtc(LocalDateTime ts) {
        return ts == null ? null : ts.atOffset(ZoneOffset.UTC).toInstant().toString();
    }
}
