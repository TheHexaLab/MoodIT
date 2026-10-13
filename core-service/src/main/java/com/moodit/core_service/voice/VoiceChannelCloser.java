// Ferme les salons LiveKit des canaux SUPPRIMES (forum seul, section 'voice' de l'éditeur, ou
// cours entier). Sans ça, un participant déjà connecté resterait dans un salon dont le canal
// n'existe plus jusqu'à l'expiration de son JoinToken : le refus d'accès ne vaut que pour les
// NOUVELLES connexions. Après commit et en meilleur effort, comme DeviceKeyNotifier.
// On envoie TOUS les ids supprimés : voice-service ne ferme que les salons actifs (les forums
// texte n'en ont jamais).

package com.moodit.core_service.voice;

import com.moodit.core_service.service.ForumsDeletedEvent;
import java.time.Duration;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.client.RestClient;

@Slf4j
@Component
@ConditionalOnProperty(prefix = "moodit.voice", name = "enabled", havingValue = "true")
public class VoiceChannelCloser {

  private final RestClient http;
  private final String voiceUrl;
  private final String internalToken;

  public VoiceChannelCloser(
      @Value("${app.voice-service.internal-url}") String voiceUrl,
      @Value("${app.internal.token:}") String internalToken) {
    // Délais COURTS : exécuté dans le fil de la requête (après commit), on ne la bloque pas.
    SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
    factory.setConnectTimeout(Duration.ofSeconds(1));
    factory.setReadTimeout(Duration.ofSeconds(3));
    this.http = RestClient.builder().requestFactory(factory).build();
    this.voiceUrl = voiceUrl;
    this.internalToken = internalToken;
  }

  @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
  public void onForumsDeleted(ForumsDeletedEvent event) {
    try {
      http.post()
          .uri(voiceUrl + "/internal/channels/deleted")
          .header("X-Internal-Token", internalToken)
          .body(Map.of("channelIds", event.forumIds()))
          .retrieve()
          .toBodilessEntity();
    } catch (Exception e) {
      // Sans fermeture, les participants restent connectés entre eux (chiffré) jusqu'à leur
      // départ ; aucune nouvelle connexion n'est possible (canal introuvable → accès refusé).
      log.warn("Salons vocaux {} non fermés : {}", event.forumIds(), e.getMessage());
    }
  }
}
