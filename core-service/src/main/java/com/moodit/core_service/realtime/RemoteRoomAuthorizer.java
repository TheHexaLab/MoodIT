// Autorisation des rooms WebSocket DELEGUEE au permission-service (PDP central).
// Remplace le SQL local de DbRoomAuthorizer : core ne decide plus lui-meme, il demande
// a permission au moment du `join`. Le transport WS (connexion, registre, diffusion)
// reste 100% dans core ; seul le oui/non sort.
//
// @Primary : c'est cette impl qui est injectee dans le handler. DbRoomAuthorizer reste
// un bean dormant (retirer @Primary ici pour revenir au SQL local).
// Fail-closed : permission injoignable => join refuse.

package com.moodit.core_service.realtime;

import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
@Primary
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
