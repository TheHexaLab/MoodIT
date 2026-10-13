// Annuaire des clés publiques d'appareil du vocal chiffré (/api/keys/**, préfixe ajouté par
// WebMvcConfig). Autorisation centrale dans le permission-service (règles /keys/**) ; ici on ne
// fait qu'appliquer « c'est MON appareil » à partir de X-User-Email (posé par le gateway).
//
//   POST   /api/keys/devices             enregistrer son appareil (idempotent)
//   GET    /api/keys/my-devices          ses appareils (« Mes appareils »)
//   DELETE /api/keys/devices/{deviceId}  révoquer un de ses appareils
//   GET    /api/keys/devices/{deviceId}  clés publiques d'un appareil (membres d'un même programme)

package com.moodit.core_service.voice.e2ee;

import com.moodit.core_service.voice.e2ee.dto.DeviceKeyDTO;
import com.moodit.core_service.voice.e2ee.dto.DeviceKeyRegisterRequest;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/keys")
@RequiredArgsConstructor
@ConditionalOnProperty(prefix = "moodit.voice", name = "enabled", havingValue = "true")
public class DeviceKeyController {

  private final DeviceKeyService service;

  @PostMapping("/devices")
  public ResponseEntity<DeviceKeyDTO> register(
      @RequestHeader(value = "X-User-Email", required = false) String email,
      @Valid @RequestBody DeviceKeyRegisterRequest body) {
    return ResponseEntity.ok(service.register(email, body));
  }

  @GetMapping("/my-devices")
  public ResponseEntity<List<DeviceKeyDTO>> myDevices(
      @RequestHeader(value = "X-User-Email", required = false) String email) {
    return ResponseEntity.ok(service.myDevices(email));
  }

  @DeleteMapping("/devices/{deviceId}")
  public ResponseEntity<Void> revoke(
      @RequestHeader(value = "X-User-Email", required = false) String email,
      @PathVariable UUID deviceId) {
    service.revoke(email, deviceId);
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/devices/{deviceId}")
  public ResponseEntity<DeviceKeyDTO> get(@PathVariable UUID deviceId) {
    return ResponseEntity.ok(service.get(deviceId));
  }
}
