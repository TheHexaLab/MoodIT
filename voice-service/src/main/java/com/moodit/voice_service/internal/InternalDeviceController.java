// Endpoint INTERNE (service a service) : core-service demande l'EJECTION d'un appareil revoque de
// tous les salons vocaux ou il est connecte. NON route par le gateway (seul /api/voice/** l'est) ;
// authentifie par le jeton partage X-Internal-Token (= app.internal.token).

package com.moodit.voice_service.internal;

import com.moodit.voice_service.livekit.LiveKitRoomAdmin;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/devices")
public class InternalDeviceController {

  private final LiveKitRoomAdmin admin;
  private final InternalToken internalToken;

  public InternalDeviceController(LiveKitRoomAdmin admin, InternalToken internalToken) {
    this.admin = admin;
    this.internalToken = internalToken;
  }

  /** L'identite LiveKit est reconstruite ici ("<userId>.<deviceId>"), jamais fournie telle quelle. */
  @PostMapping("/{deviceId}/eject")
  public ResponseEntity<Map<String, Integer>> eject(
      @RequestHeader(value = "X-Internal-Token", required = false) String token,
      @PathVariable UUID deviceId,
      @RequestParam int userId) {
    if (internalToken.rejects(token)) {
      return ResponseEntity.status(403).build();
    }
    int removed = admin.removeEverywhere(userId + "." + deviceId);
    return ResponseEntity.ok(Map.of("removedFrom", removed));
  }
}
