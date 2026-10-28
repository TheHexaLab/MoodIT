// Met le corps de la requete en cache pour qu'il soit lisible PLUSIEURS fois :
// une fois par le filtre (pour le transmettre au permission-service), une fois par le
// service en aval (core). Sans ca, lire le body dans le filtre "consommerait" le flux
// et core recevrait un corps vide.
//
// Objet a portee requete : aucune reference long-terme, recupere par le GC en fin de
// requete (pas de fuite memoire). La lecture est BORNEE ici (#31), quel que soit le
// Content-Length annonce : une requete chunked n'en annonce aucun.

package com.moodit.gateway.filter;

import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

public class CachedBodyRequest extends HttpServletRequestWrapper {

  private final byte[] cachedBody;

  private CachedBodyRequest(HttpServletRequest request, byte[] body) {
    super(request);
    this.cachedBody = body;
  }

  /**
   * Lit au plus {@code maxBytes + 1} octets du corps. S'il tient dans {@code maxBytes}, renvoie
   * une {@link CachedBodyRequest} (corps relisable, transmis au permission-service) ; sinon
   * {@code null} : la requête doit être refusée, car l'autorisation ne peut pas être décidée sans
   * le corps que le service en aval recevrait.
   */
  static CachedBodyRequest read(HttpServletRequest request, int maxBytes) throws IOException {
    byte[] body = request.getInputStream().readNBytes(maxBytes + 1);
    return body.length <= maxBytes ? new CachedBodyRequest(request, body) : null;
  }

  /** Le corps mis en cache, decode en chaine (pour l'envoi au permission-service). */
  public String getBodyAsString() {
    return new String(cachedBody, charset());
  }

  private Charset charset() {
    String enc = getCharacterEncoding();
    return enc != null ? Charset.forName(enc) : StandardCharsets.UTF_8;
  }

  @Override
  public ServletInputStream getInputStream() {
    ByteArrayInputStream source = new ByteArrayInputStream(cachedBody);
    return new ServletInputStream() {
      @Override
      public int read() {
        return source.read();
      }

      @Override
      public boolean isFinished() {
        return source.available() == 0;
      }

      @Override
      public boolean isReady() {
        return true;
      }

      @Override
      public void setReadListener(ReadListener listener) {
        // Lecture synchrone uniquement (le proxy du gateway lit le body de maniere bloquante).
      }
    };
  }

  @Override
  public BufferedReader getReader() {
    return new BufferedReader(new InputStreamReader(getInputStream(), charset()));
  }
}
