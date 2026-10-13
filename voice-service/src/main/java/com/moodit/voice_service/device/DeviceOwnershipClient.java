// Verifie aupres de core-service que l'appareil (deviceId) est ACTIF et appartient a l'utilisateur,
// AVANT de signer un JoinToken dont l'identite LiveKit est "<userId>.<deviceId>" (E2EE.md §5.4).
// Endpoint interne core /internal/keys/devices/{id}/owner, authentifie par X-Internal-Token.
// Fail-closed : core injoignable, 404 ou 403 => vide => pas de token.

package com.moodit.voice_service.device;

import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class DeviceOwnershipClient {

  /** Proprietaire d'un appareil actif (miroir de core DeviceOwnerDTO). */
  public record DeviceOwner(int userId, String username) {}

  private final RestClient restClient = RestClient.create();
  private final String coreUrl;
  private final String internalToken;

  public DeviceOwnershipClient(
      @Value("${app.core-service.internal-url}") String coreUrl,
      @Value("${app.internal.token:}") String internalToken) {
    this.coreUrl = coreUrl;
    this.internalToken = internalToken;
  }

  /** @return le proprietaire si l'appareil est actif ET a `email` ; vide sinon (fail-closed). */
  public Optional<DeviceOwner> activeOwner(UUID deviceId, String email) {
    try {
      DeviceOwner owner =
          restClient
              .get()
              .uri(
                  coreUrl + "/internal/keys/devices/{deviceId}/owner?email={email}",
                  deviceId,
                  email)
              .header("X-Internal-Token", internalToken)
              .retrieve()
              .body(DeviceOwner.class);
      return Optional.ofNullable(owner);
    } catch (Exception e) {
      return Optional.empty(); // 404 (pas a lui / revoque), 403, core injoignable : refus.
    }
  }
}
