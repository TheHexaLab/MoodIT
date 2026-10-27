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
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.SequenceInputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

public class CachedBodyRequest extends HttpServletRequestWrapper {

  private final byte[] cachedBody;

  CachedBodyRequest(HttpServletRequest request, byte[] body) {
    super(request);
    this.cachedBody = body;
  }

  /**
   * Lit au plus {@code maxBytes + 1} octets du corps. S'il tient dans {@code maxBytes}, renvoie
   * une {@link CachedBodyRequest} (corps relisable, transmis au permission-service). Sinon, renvoie
   * une requête qui rejoue les octets déjà lus puis le reste du flux, sans rien garder en mémoire
   * au-delà de la borne : le service en aval reçoit le corps intact, le permission-service n'en
   * reçoit aucun (comme pour un Content-Length annoncé trop gros).
   */
  static HttpServletRequest read(HttpServletRequest request, int maxBytes) throws IOException {
    ServletInputStream in = request.getInputStream();
    byte[] head = in.readNBytes(maxBytes + 1);
    if (head.length <= maxBytes) {
      return new CachedBodyRequest(request, head);
    }
    return new ReplayedBodyRequest(request, new SequenceInputStream(new ByteArrayInputStream(head), in));
  }

  /** Le corps mis en cache, decode en chaine (pour l'envoi au permission-service). */
  public String getBodyAsString() {
    return new String(cachedBody, charset());
  }

  private Charset charset() {
    return charsetOf(this);
  }

  private static Charset charsetOf(HttpServletRequest request) {
    String enc = request.getCharacterEncoding();
    return enc != null ? Charset.forName(enc) : StandardCharsets.UTF_8;
  }

  @Override
  public ServletInputStream getInputStream() {
    return servletStream(new ByteArrayInputStream(cachedBody));
  }

  @Override
  public BufferedReader getReader() {
    return new BufferedReader(new InputStreamReader(getInputStream(), charset()));
  }

  /** Flux servlet synchrone au-dessus de {@code source}. */
  private static ServletInputStream servletStream(InputStream source) {
    return new ServletInputStream() {
      private boolean finished;

      @Override
      public int read() throws IOException {
        int b = source.read();
        finished = b < 0;
        return b;
      }

      @Override
      public int read(byte[] buf, int off, int len) throws IOException {
        int n = source.read(buf, off, len);
        finished = n < 0;
        return n;
      }

      // En memoire, available() == 0 signale la fin ; sinon (flux rejoue) seule une lecture
      // renvoyant -1 le prouve.
      @Override
      public boolean isFinished() {
        return finished || source instanceof ByteArrayInputStream bytes && bytes.available() == 0;
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

  /** Corps trop gros pour le cache : les octets deja lus, puis le reste du flux d'origine. */
  private static final class ReplayedBodyRequest extends HttpServletRequestWrapper {

    private final ServletInputStream stream;

    ReplayedBodyRequest(HttpServletRequest request, InputStream body) {
      super(request);
      this.stream = servletStream(body);
    }

    @Override
    public ServletInputStream getInputStream() {
      return stream;
    }

    @Override
    public BufferedReader getReader() {
      return new BufferedReader(new InputStreamReader(stream, charsetOf(this)));
    }
  }
}
