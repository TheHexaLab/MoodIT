package com.moodit.gateway.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.ResourceAccessException;

/** Délais des appels internes du gateway (#31) : un service qui ne répond pas fait échouer l'appel. */
class HttpClientsTest {

  private HttpServer server;

  @AfterEach
  void stopServer() {
    if (server != null) {
      server.stop(0);
    }
  }

  /** Mini serveur qui répond « ok » après {@code delayMs}. */
  private String startServer(long delayMs) throws IOException {
    server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          try {
            Thread.sleep(delayMs);
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
          }
          byte[] bytes = "ok".getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(200, bytes.length);
          try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
          } catch (IOException ignored) {
            // client déjà parti (délai dépassé)
          }
          exchange.close();
        });
    server.start();
    return "http://localhost:" + server.getAddress().getPort();
  }

  @Test
  void reponseDansLeDelai_renvoyee() throws Exception {
    String url = startServer(0);

    String body =
        HttpClients.withTimeouts(Duration.ofSeconds(2), Duration.ofSeconds(2))
            .get()
            .uri(url)
            .retrieve()
            .body(String.class);

    assertThat(body).isEqualTo("ok");
  }

  @Test
  void reponseTropLente_delaiDeLectureDepasse() throws Exception {
    String url = startServer(2_000);

    assertThatThrownBy(
            () ->
                HttpClients.withTimeouts(Duration.ofSeconds(2), Duration.ofMillis(100))
                    .get()
                    .uri(url)
                    .retrieve()
                    .body(String.class))
        .isInstanceOf(ResourceAccessException.class);
  }

  @Test
  void delaisDesAppelsInternes() {
    assertThat(HttpClients.CONNECT_TIMEOUT).isEqualTo(Duration.ofSeconds(2));
    assertThat(HttpClients.READ_TIMEOUT).isEqualTo(Duration.ofSeconds(5));
    assertThat(HttpClients.internal()).isNotNull();
  }
}
