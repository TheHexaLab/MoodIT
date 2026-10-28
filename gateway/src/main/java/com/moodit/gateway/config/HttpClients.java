// RestClient des appels du gateway vers auth-service et permission-service, avec des délais
// explicites (#31). Sans délai, un service bloqué immobiliserait un thread du gateway par
// requête, jusqu'à épuiser le pool : tout le site tomberait avec lui. Ces appels sont des
// lectures courtes (validation de token, décision d'autorisation) : quelques secondes suffisent,
// et un dépassement est traité comme une panne (fail-closed, 503).

package com.moodit.gateway.config;

import java.time.Duration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

public final class HttpClients {

  /** Délai d'établissement de la connexion. */
  public static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(2);

  /** Délai d'attente de la réponse, une fois connecté. */
  public static final Duration READ_TIMEOUT = Duration.ofSeconds(5);

  private HttpClients() {}

  /** Client des appels internes du gateway (auth-service, permission-service). */
  public static RestClient internal() {
    return withTimeouts(CONNECT_TIMEOUT, READ_TIMEOUT);
  }

  static RestClient withTimeouts(Duration connect, Duration read) {
    SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
    factory.setConnectTimeout(connect);
    factory.setReadTimeout(read);
    return RestClient.builder().requestFactory(factory).build();
  }
}
