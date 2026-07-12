// Fabrique centralisee du cookie de session (moodit_token). Regroupe TOUS les attributs
// de securite en un seul endroit pour garantir qu'emission et suppression partagent
// exactement les memes (sinon le navigateur ne supprime pas le cookie au logout).
//
//   - HttpOnly  : invisible au JavaScript -> un XSS ne peut pas voler le token.
//   - Secure    : HTTPS uniquement (true en prod, false en dev http via app.cookie.secure).
//   - SameSite=Strict : le navigateur n'envoie jamais le cookie depuis un autre site
//                       -> protection CSRF (l'app est mono-origine : proxy Vite / gateway).
//   - Max-Age   : aligne sur app.jwt.expiration pour ne jamais renvoyer un token expire.

package com.moodit.auth_service.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Component;

@Component
public class AuthCookie {

  /** Nom du cookie porteur du JWT. Doit rester aligne avec la lecture cote gateway. */
  public static final String NAME = "moodit_token";

  private final boolean secure;
  private final long maxAgeSeconds;

  public AuthCookie(
      @Value("${app.cookie.secure}") boolean secure,
      @Value("${app.jwt.expiration}") long jwtExpirationMs) {
    this.secure = secure;
    this.maxAgeSeconds = jwtExpirationMs / 1000;
  }

  /** Cookie posant le token pour la duree de validite du JWT. */
  public ResponseCookie build(String token) {
    return base(token).maxAge(maxAgeSeconds).build();
  }

  /**
   * Cookie de suppression (Max-Age=0), memes attributs que {@link #build}. Destine au
   * futur endpoint /auth/logout (tache d'un autre membre) : le navigateur n'efface le
   * cookie que si l'ensemble Path/Secure/SameSite correspond a celui de la pose.
   */
  public ResponseCookie clear() {
    return base("").maxAge(0).build();
  }

  private ResponseCookie.ResponseCookieBuilder base(String value) {
    return ResponseCookie.from(NAME, value)
        .httpOnly(true)
        .secure(secure)
        .sameSite("Strict")
        .path("/");
  }
}
