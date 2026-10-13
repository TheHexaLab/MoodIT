// Effets EXTERNES des évènements d'appareil, après commit et en meilleur effort (un service
// injoignable ne fait jamais échouer l'enregistrement ou la révocation, déjà validés) :
//   - Registered → auth-service envoie l'email « nouvel appareil » (E2EE.md §5.3) ;
//   - Revoked    → voice-service éjecte l'appareil des salons LiveKit où il est connecté.
// Appels internes (/internal/**, non routés par le gateway) authentifiés par X-Internal-Token.

package com.moodit.core_service.voice.e2ee;

import java.time.Duration;
import java.time.format.DateTimeFormatter;
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
public class DeviceKeyNotifier {

  private static final DateTimeFormatter WHEN = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

  private final RestClient http;
  private final String authUrl;
  private final String voiceUrl;
  private final String internalToken;

  public DeviceKeyNotifier(
      @Value("${app.auth-service.internal-url}") String authUrl,
      @Value("${app.voice-service.internal-url}") String voiceUrl,
      @Value("${app.internal.token:}") String internalToken) {
    // Délais COURTS : exécuté dans le fil de la requête (après commit), on ne la bloque pas.
    SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
    factory.setConnectTimeout(Duration.ofSeconds(1));
    factory.setReadTimeout(Duration.ofSeconds(3));
    this.http = RestClient.builder().requestFactory(factory).build();
    this.authUrl = authUrl;
    this.voiceUrl = voiceUrl;
    this.internalToken = internalToken;
  }

  @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
  public void onRegistered(DeviceKeyEvents.Registered event) {
    try {
      http.post()
          .uri(authUrl + "/internal/mail/new-voice-device")
          .header("X-Internal-Token", internalToken)
          .body(
              Map.of(
                  "email", event.email(),
                  "label", event.label() == null ? "" : event.label(),
                  "createdAt", event.createdAt().format(WHEN)))
          .retrieve()
          .toBodilessEntity();
    } catch (Exception e) {
      log.warn("Email « nouvel appareil » non demandé à auth-service : {}", e.getMessage());
    }
  }

  @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
  public void onRevoked(DeviceKeyEvents.Revoked event) {
    try {
      http.post()
          .uri(
              voiceUrl + "/internal/devices/{deviceId}/eject?userId={userId}",
              event.deviceId(),
              event.userId())
          .header("X-Internal-Token", internalToken)
          .retrieve()
          .toBodilessEntity();
    } catch (Exception e) {
      // Sans éjection, l'appareil révoqué reste connecté jusqu'à sa déconnexion, MAIS les autres
      // participants le rejettent déjà (annuaire : révoqué) → il ne reçoit plus aucune clé.
      log.warn("Éjection de l'appareil {} non effectuée : {}", event.deviceId(), e.getMessage());
    }
  }
}
