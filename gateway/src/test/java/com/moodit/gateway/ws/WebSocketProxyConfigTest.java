package com.moodit.gateway.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/**
 * Parsing des origines WebSocket autorisées (anti-CSWSH). Point sensible : une config VIDE ne
 * doit PAS produire un tableau vide (qui désactiverait le contrôle d'Origin côté Spring) mais
 * échouer au démarrage.
 */
class WebSocketProxyConfigTest {

  @Test
  void singleOrigin() {
    assertThat(WebSocketProxyConfig.parseAllowedOrigins("http://localhost:5173"))
        .containsExactly("http://localhost:5173");
  }

  @Test
  void trimsEntriesAndFiltersEmpties() {
    assertThat(WebSocketProxyConfig.parseAllowedOrigins(" http://a , http://b ,"))
        .containsExactly("http://a", "http://b");
  }

  @Test
  void emptyString_failsFast() {
    assertThatThrownBy(() -> WebSocketProxyConfig.parseAllowedOrigins(""))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void blanksAndCommasOnly_failsFast() {
    assertThatThrownBy(() -> WebSocketProxyConfig.parseAllowedOrigins("  , , "))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void nullValue_failsFast() {
    assertThatThrownBy(() -> WebSocketProxyConfig.parseAllowedOrigins(null))
        .isInstanceOf(IllegalStateException.class);
  }
}
