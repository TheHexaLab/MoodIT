// Code 2FA FIXE, pour le DÉVELOPPEMENT uniquement (tests manuels et E2E sans boîte mail).
//
// Activé par moodit.auth.dev-fixed-2fa-code=<6 chiffres> (vide par défaut = désactivé). Seul le
// CODE change : le parcours reste celui de la prod (écran 2FA, plafond d'essais, verrou 15 min,
// hash HMAC en BD), donc le vrai chemin 2FA continue d'être exercé en dev.
//
// DEUX verrous : la propriété explicite ET le profil "dev" (sans "prod"). Toute autre combinaison
// avec la propriété renseignée FAIT ÉCHOUER LE DÉMARRAGE (fail-fast) : une erreur de config ne
// peut pas ouvrir la 2FA d'un environnement déployé.

package com.moodit.auth_service.config;

import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

@Slf4j
@Component
public class DevFixedTwoFactorCode {

  static final String PROPERTY = "moodit.auth.dev-fixed-2fa-code";

  private final String code;

  public DevFixedTwoFactorCode(Environment env) {
    String value = env.getProperty(PROPERTY, "").trim();
    if (value.isEmpty()) {
      this.code = null;
      return;
    }
    if (!env.acceptsProfiles(Profiles.of("dev")) || env.acceptsProfiles(Profiles.of("prod"))) {
      throw new IllegalStateException(
          PROPERTY + " est INTERDIT hors profil dev (profils actifs : "
              + String.join(",", env.getActiveProfiles()) + "). Retirer la propriété.");
    }
    if (!value.matches("\\d{6}")) {
      throw new IllegalStateException(PROPERTY + " doit faire exactement 6 chiffres.");
    }
    this.code = value;
    log.warn(
        "⚠ 2FA EN MODE DEV : code fixe actif ({}). Ne jamais utiliser hors poste de développement.",
        PROPERTY);
  }

  /** Code fixe si le mode dev est actif, vide sinon (→ code aléatoire normal). */
  public Optional<String> code() {
    return Optional.ofNullable(code);
  }
}
