// Autorisation DELEGUEE au permission-service (PDP central) : voice-service ne decide pas
// lui-meme, il demande a permission au moment de l'emission du JoinToken. Meme contrat que le
// RemoteRoomAuthorizer de core (POST /permissions/can-join). Sans etat (juste un RestClient).
// Fail-closed : permission injoignable => refus.

package com.moodit.voice_service.authz;

import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class RemoteRoomAuthorizer implements RoomAuthorizer {

  private final String permissionServiceUrl;
  private final RestClient restClient = RestClient.create();

  public RemoteRoomAuthorizer(
      @Value("${app.permission-service.url}") String permissionServiceUrl) {
    this.permissionServiceUrl = permissionServiceUrl;
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
