package com.moodit.gateway.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.net.ConnectException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedConstruction;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;

/**
 * Proxy WebSocket navigateur ↔ core-service. Le handler instancie lui-même son
 * StandardWebSocketClient : on l'intercepte avec mockConstruction pour contrôler la connexion
 * aval (session mockée ou échec) et capturer le handler de relais aval. On couvre la
 * réinjection du token en header Authorization (jamais en query), le relais amont → aval et
 * aval → amont des trames texte et binaires, la fermeture propagée dans les deux sens avec le
 * même statut, et la fermeture du client (SERVER_ERROR) quand core est injoignable.
 */
class WebSocketProxyHandlerTest {

  private static final String CORE_WS_URL = "ws://core:8081/ws";

  private WebSocketProxyHandler handler;
  private WebSocketSession client;
  private WebSocketSession downstream;
  private Map<String, Object> attributes;

  /** Interception des StandardWebSocketClient construits par le handler. */
  private MockedConstruction<StandardWebSocketClient> clientConstruction;

  @BeforeEach
  void setUp() {
    handler = new WebSocketProxyHandler(CORE_WS_URL);

    attributes = new HashMap<>();
    client = mock(WebSocketSession.class);
    when(client.getId()).thenReturn("client-1");
    when(client.getAttributes()).thenReturn(attributes);
    when(client.isOpen()).thenReturn(true);

    downstream = mock(WebSocketSession.class);
    when(downstream.getId()).thenReturn("aval-1");
    when(downstream.isOpen()).thenReturn(true);
  }

  @AfterEach
  void tearDown() {
    if (clientConstruction != null) {
      clientConstruction.close();
    }
  }

  /** Le client WS construit par le handler renverra `future` à l'appel execute(). */
  private void stubDownstream(CompletableFuture<WebSocketSession> future) {
    if (clientConstruction != null) {
      clientConstruction.close();
    }
    clientConstruction =
        mockConstruction(
            StandardWebSocketClient.class,
            (mock, context) ->
                when(mock.execute(
                        any(WebSocketHandler.class),
                        any(WebSocketHttpHeaders.class),
                        any(URI.class)))
                    .thenReturn(future));
  }

  private StandardWebSocketClient constructedClient() {
    assertThat(clientConstruction.constructed()).hasSize(1);
    return clientConstruction.constructed().get(0);
  }

  /** Arguments passés à execute() lors de l'ouverture aval. */
  private record ExecuteCall(WebSocketHandler relay, WebSocketHttpHeaders headers, URI uri) {}

  private ExecuteCall capturedExecute() {
    ArgumentCaptor<WebSocketHandler> relay = ArgumentCaptor.forClass(WebSocketHandler.class);
    ArgumentCaptor<WebSocketHttpHeaders> headers =
        ArgumentCaptor.forClass(WebSocketHttpHeaders.class);
    ArgumentCaptor<URI> uri = ArgumentCaptor.forClass(URI.class);
    verify(constructedClient()).execute(relay.capture(), headers.capture(), uri.capture());
    return new ExecuteCall(relay.getValue(), headers.getValue(), uri.getValue());
  }

  /** Ouvre la connexion aval avec succès et renvoie le handler de relais aval capturé. */
  private DownstreamRelayHandler connect() throws Exception {
    stubDownstream(CompletableFuture.completedFuture(downstream));
    handler.afterConnectionEstablished(client);
    WebSocketHandler relay = capturedExecute().relay();
    assertThat(relay).isInstanceOf(DownstreamRelayHandler.class);
    return (DownstreamRelayHandler) relay;
  }

  // ------------------------------------------------------------------ ouverture aval

  @Test
  void ouverture_seConnecteAuCoreAvecLeTokenEnHeaderAuthorization() throws Exception {
    attributes.put(AuthHandshakeInterceptor.TOKEN_ATTR, "tok");
    stubDownstream(CompletableFuture.completedFuture(downstream));

    handler.afterConnectionEstablished(client);

    ExecuteCall call = capturedExecute();
    assertThat(call.headers().get("Authorization")).containsExactly("Bearer tok");
    // Le JWT ne doit jamais transiter en query (logs / URLs) : URL aval nue, celle configurée.
    assertThat(call.uri()).isEqualTo(URI.create(CORE_WS_URL));
    assertThat(call.uri().getQuery()).isNull();
    // Connexion réussie : le client reste ouvert.
    verify(client, never()).close(any());
  }

  @Test
  void ouverture_sansToken_nEnvoiePasDeHeaderAuthorization() throws Exception {
    stubDownstream(CompletableFuture.completedFuture(downstream));

    handler.afterConnectionEstablished(client);

    assertThat(capturedExecute().headers().containsHeader("Authorization")).isFalse();
  }

  @Test
  void ouverture_tokenBlanc_nEnvoiePasDeHeaderAuthorization() throws Exception {
    attributes.put(AuthHandshakeInterceptor.TOKEN_ATTR, "   ");
    stubDownstream(CompletableFuture.completedFuture(downstream));

    handler.afterConnectionEstablished(client);

    assertThat(capturedExecute().headers().containsHeader("Authorization")).isFalse();
  }

  @Test
  void ouverture_coreInjoignable_fermeLeClientEnServerError() throws Exception {
    attributes.put(AuthHandshakeInterceptor.TOKEN_ATTR, "tok");
    stubDownstream(CompletableFuture.failedFuture(new ConnectException("connexion refusée")));

    // L'échec aval ne remonte pas en exception : le handler ferme proprement le client.
    handler.afterConnectionEstablished(client);

    verify(client).close(CloseStatus.SERVER_ERROR);
  }

  @Test
  void ouverture_coreInjoignable_aucunRelaisEnsuite() throws Exception {
    stubDownstream(CompletableFuture.failedFuture(new RuntimeException("handshake aval refusé")));
    handler.afterConnectionEstablished(client);

    // Aucune session aval enregistrée : rien n'est relayé, la fermeture ne touche rien.
    handler.handleMessage(client, new TextMessage("hello"));
    handler.afterConnectionClosed(client, CloseStatus.NORMAL);

    verify(downstream, never()).sendMessage(any());
    verify(downstream, never()).close(any());
  }

  @Test
  void relaisAval_envoisConcurrentsVersLeClient_serialises_sansPerteNiBlocage() throws Exception {
    // Garde-fou concurrence (observable) : une session WebSocket n'accepte pas deux écritures
    // simultanées. Si un envoi vers le navigateur est en cours (réseau lent), un 2e envoi venu d'un
    // autre thread ne doit NI écrire en parallèle, NI bloquer son thread : il est mis en tampon puis
    // livré, dans l'ordre, par le premier. C'est ce que garantit le décorateur concurrent.
    DownstreamRelayHandler relay = connect();
    CountDownLatch firstSendEntered = new CountDownLatch(1);
    CountDownLatch releaseFirstSend = new CountDownLatch(1);
    AtomicInteger inFlight = new AtomicInteger();
    AtomicInteger maxInFlight = new AtomicInteger();
    List<Object> delivered = new CopyOnWriteArrayList<>();
    doAnswer(
            inv -> {
              maxInFlight.accumulateAndGet(inFlight.incrementAndGet(), Math::max);
              try {
                if (delivered.isEmpty()) {
                  firstSendEntered.countDown();
                  releaseFirstSend.await(5, TimeUnit.SECONDS);
                }
                delivered.add(inv.getArgument(0));
              } finally {
                inFlight.decrementAndGet();
              }
              return null;
            })
        .when(client)
        .sendMessage(any());
    TextMessage first = new TextMessage("premier");
    TextMessage second = new TextMessage("second");
    ExecutorService threads = Executors.newFixedThreadPool(2);
    try {
      Future<?> a = threads.submit(() -> {
        relay.handleMessage(downstream, first);
        return null;
      });
      assertThat(firstSendEntered.await(5, TimeUnit.SECONDS)).isTrue();

      // Pendant que le 1er envoi est bloqué, le 2e rend la main sans écrire.
      threads
          .submit(
              () -> {
                relay.handleMessage(downstream, second);
                return null;
              })
          .get(2, TimeUnit.SECONDS);
      assertThat(delivered).isEmpty();

      releaseFirstSend.countDown();
      a.get(5, TimeUnit.SECONDS);
      assertThat(delivered).containsExactly(first, second);
      assertThat(maxInFlight).hasValue(1);
    } finally {
      releaseFirstSend.countDown();
      threads.shutdownNow();
    }
  }

  // ------------------------------------------------------------------ amont → aval

  @Test
  void texteDuClient_relayeVersCore() throws Exception {
    connect();
    TextMessage message = new TextMessage("SEND\ndestination:/app/x\n\n{}\u0000");

    handler.handleMessage(client, message);

    verify(downstream).sendMessage(message);
  }

  @Test
  void binaireDuClient_relayeVersCore() throws Exception {
    connect();
    BinaryMessage message = new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3}));

    handler.handleMessage(client, message);

    verify(downstream).sendMessage(message);
  }

  @Test
  void texteDuClient_avalFerme_nonRelaye() throws Exception {
    connect();
    when(downstream.isOpen()).thenReturn(false);

    handler.handleMessage(client, new TextMessage("hello"));

    verify(downstream, never()).sendMessage(any());
  }

  @Test
  void texteDunClientInconnu_nonRelaye() throws Exception {
    connect();
    WebSocketSession stranger = mock(WebSocketSession.class);
    when(stranger.getId()).thenReturn("client-autre");

    // Un client sans session aval ne doit jamais écrire dans l'aval d'un autre client.
    handler.handleMessage(stranger, new TextMessage("hello"));

    verify(downstream, never()).sendMessage(any());
  }

  @Test
  void deuxClients_chacunSonPropreAval() throws Exception {
    connect(); // client-1 → downstream

    WebSocketSession client2 = mock(WebSocketSession.class);
    when(client2.getId()).thenReturn("client-2");
    when(client2.getAttributes()).thenReturn(new HashMap<>());
    WebSocketSession downstream2 = mock(WebSocketSession.class);
    when(downstream2.isOpen()).thenReturn(true);
    stubDownstream(CompletableFuture.completedFuture(downstream2));
    handler.afterConnectionEstablished(client2); // client-2 → downstream2

    TextMessage m1 = new TextMessage("de-1");
    TextMessage m2 = new TextMessage("de-2");
    handler.handleMessage(client, m1);
    handler.handleMessage(client2, m2);

    verify(downstream).sendMessage(m1);
    verify(downstream, never()).sendMessage(m2);
    verify(downstream2).sendMessage(m2);
    verify(downstream2, never()).sendMessage(m1);
  }

  // ------------------------------------------------------------------ fermeture amont → aval

  @Test
  void fermetureDuClient_propageeVersCoreAvecLeMemeStatut() throws Exception {
    connect();
    CloseStatus status = new CloseStatus(1001, "going away");

    handler.afterConnectionClosed(client, status);

    verify(downstream).close(status);
  }

  @Test
  void fermetureDuClient_avalDejaFerme_neRefermePas() throws Exception {
    connect();
    when(downstream.isOpen()).thenReturn(false);

    handler.afterConnectionClosed(client, CloseStatus.NORMAL);

    verify(downstream, never()).close(any());
  }

  @Test
  void fermetureDuClient_oublieLaSessionAval() throws Exception {
    connect();
    handler.afterConnectionClosed(client, CloseStatus.NORMAL);

    // Après la fermeture, plus rien n'est relayé ni refermé pour cet id client.
    handler.handleMessage(client, new TextMessage("tardif"));
    handler.afterConnectionClosed(client, CloseStatus.NORMAL);

    verify(downstream, never()).sendMessage(any());
    verify(downstream, times(1)).close(any());
  }

  @Test
  void fermetureDunClientInconnu_sansEffetSurLesAutres() throws Exception {
    connect();
    WebSocketSession stranger = mock(WebSocketSession.class);
    when(stranger.getId()).thenReturn("client-autre");

    handler.afterConnectionClosed(stranger, CloseStatus.NORMAL);

    verify(downstream, never()).close(any());
  }

  // ------------------------------------------------------------------ aval → amont

  @Test
  void texteDeCore_relayeVersLeClient() throws Exception {
    DownstreamRelayHandler relay = connect();
    TextMessage message = new TextMessage("MESSAGE\n\n{\"ping\":1}\u0000");

    relay.handleMessage(downstream, message);

    // Le décorateur concurrent délègue l'envoi à la session brute du navigateur.
    verify(client).sendMessage(message);
  }

  @Test
  void binaireDeCore_relayeVersLeClient() throws Exception {
    DownstreamRelayHandler relay = connect();
    BinaryMessage message = new BinaryMessage(ByteBuffer.wrap(new byte[] {9, 8}));

    relay.handleMessage(downstream, message);

    verify(client).sendMessage(message);
  }

  @Test
  void texteDeCore_clientFerme_nonRelaye() throws Exception {
    DownstreamRelayHandler relay = connect();
    when(client.isOpen()).thenReturn(false);

    relay.handleMessage(downstream, new TextMessage("hello"));

    verify(client, never()).sendMessage(any());
  }

  @Test
  void binaireDeCore_clientFerme_nonRelaye() throws Exception {
    DownstreamRelayHandler relay = connect();
    when(client.isOpen()).thenReturn(false);

    relay.handleMessage(downstream, new BinaryMessage(new byte[] {1}));

    verify(client, never()).sendMessage(any());
  }

  // ------------------------------------------------------------------ fermeture aval → amont

  @Test
  void fermetureDeCore_propageeVersLeClientAvecLeMemeStatut() throws Exception {
    DownstreamRelayHandler relay = connect();
    CloseStatus status = new CloseStatus(4001, "token expiré");

    relay.afterConnectionClosed(downstream, status);

    verify(client).close(status);
  }

  @Test
  void fermetureDeCore_clientDejaFerme_neRefermePas() throws Exception {
    DownstreamRelayHandler relay = connect();
    when(client.isOpen()).thenReturn(false);

    relay.afterConnectionClosed(downstream, CloseStatus.NORMAL);

    verify(client, never()).close(any());
  }
}
