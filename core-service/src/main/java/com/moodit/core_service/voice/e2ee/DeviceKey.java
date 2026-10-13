// Clés PUBLIQUES d'un appareil (profil de navigateur) pour le vocal chiffré de bout en bout.
// Table Device_Key (init.sql). Aucune clé privée côté serveur. Clés immuables : un appareil
// qui régénère ses clés s'enregistre sous un NOUVEAU deviceId (cf. voice-service/E2EE.md §5.2).

package com.moodit.core_service.voice.e2ee;

import com.moodit.core_service.model.User;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table(name = "device_key")
public class DeviceKey {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Integer id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "user_id", nullable = false)
  private User user;

  @Column(name = "device_id", nullable = false, unique = true)
  private UUID deviceId;

  @Column(length = 64)
  private String label;

  @Column(name = "sign_pub", nullable = false, columnDefinition = "TEXT")
  private String signPub;

  @Column(name = "dh_pub", nullable = false, columnDefinition = "TEXT")
  private String dhPub;

  @Column(name = "dh_sig", nullable = false, columnDefinition = "TEXT")
  private String dhSig;

  @Column(name = "created_at", nullable = false)
  private LocalDateTime createdAt;

  @Column(name = "revoked_at")
  private LocalDateTime revokedAt;

  public boolean isRevoked() {
    return revokedAt != null;
  }
}
