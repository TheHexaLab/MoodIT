// Autorisation des rooms WebSocket DELEGUEE au permission-service (PDP central) : core ne
// decide plus lui-meme, il demande a permission au moment du `join`. Le transport WS
// (connexion, registre, diffusion) reste 100% dans core ; seul le oui/non sort. C'est
// l'UNIQUE implementation de RoomAuthorizer (l'ancien SQL local DbRoomAuthorizer a ete
// retire pour ne garder AUCUNE logique d'autorisation par role hors permission-service).
// Fail-closed : permission injoignable => join refuse.

package com.moodit.core_service.realtime;

import java.time.Duration;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class RemoteRoomAuthorizer implements RoomAuthorizer {

  private final String permissionServiceUrl;
  private final RestClient restClient;

  public RemoteRoomAuthorizer(
      @Value("${app.permission-service.url}") String permissionServiceUrl) {
    this.permissionServiceUrl = permissionServiceUrl;
    // Délais explicites (#31) : un permission-service bloqué ne doit pas immobiliser le thread
    // WebSocket du `join`. Dépassement = panne = refus (fail-closed, ci-dessous).
    SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
    factory.setConnectTimeout(Duration.ofSeconds(2));
    factory.setReadTimeout(Duration.ofSeconds(5));
    this.restClient = RestClient.builder().requestFactory(factory).build();
  }

  @Override
  public boolean canJoin(String email, String scope, long id) {
    if (email == null || email.isBlank()) {
      return false;
    }
    try {
      Map<?, ?> body =
          restClient
              .post()
              .uri(permissionServiceUrl + "/permissions/can-join")
              .body(Map.of("email", email, "scope", scope, "id", id))
              .retrieve()
              .body(Map.class);
      return body != null && Boolean.TRUE.equals(body.get("allowed"));
    } catch (Exception e) {
      return false; // permission injoignable : on refuse (fail-closed).
    }
  }
}
