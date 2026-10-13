// Évènements du cycle de vie des appareils du vocal chiffré, publiés par DeviceKeyService et
// traités APRÈS COMMIT par DeviceKeyNotifier (jamais d'effet externe pour une transaction annulée).

package com.moodit.core_service.voice.e2ee;

import java.time.LocalDateTime;
import java.util.UUID;

public final class DeviceKeyEvents {

  private DeviceKeyEvents() {}

  /** Un NOUVEL appareil a été enregistré (pas un ré-enregistrement idempotent). */
  public record Registered(String email, String label, LocalDateTime createdAt) {}

  /** Un appareil vient d'être révoqué : à éjecter des salons où il est connecté. */
  public record Revoked(int userId, UUID deviceId) {}
}
