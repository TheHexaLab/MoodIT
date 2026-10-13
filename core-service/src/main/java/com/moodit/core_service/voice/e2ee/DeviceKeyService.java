// Annuaire des clés publiques d'appareil du vocal chiffré (voice-service/E2EE.md §5.2).
//
// Le serveur STOCKE et DISTRIBUE des clés publiques, il ne fait pas foi : chaque client vérifie
// lui-même (TOFU + codes de sécurité, §5.3). Les contrôles ici protègent l'intégrité de l'annuaire
// (un appareil appartient à UN utilisateur, clés immuables, format valide), pas la confidentialité.
//
// Greffon retirable : actif seulement si moodit.voice.enabled=true, comme la présence vocale.

package com.moodit.core_service.voice.e2ee;

import com.moodit.core_service.model.User;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.voice.e2ee.dto.DeviceKeyDTO;
import com.moodit.core_service.voice.e2ee.dto.DeviceKeyRegisterRequest;
import com.moodit.core_service.voice.e2ee.dto.DeviceOwnerDTO;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
@ConditionalOnProperty(prefix = "moodit.voice", name = "enabled", havingValue = "true")
public class DeviceKeyService {

  /** Plafond d'appareils ACTIFS par utilisateur (borne l'annuaire en cas d'abus/bug client). */
  static final int MAX_ACTIVE_DEVICES = 20;

  private final DeviceKeyRepository devices;
  private final UserRepository users;
  /** Effets externes (email, éjection) publiés ici, exécutés après commit (DeviceKeyNotifier). */
  private final ApplicationEventPublisher events;

  /**
   * Enregistre l'appareil de l'utilisateur courant. Idempotent : ré-enregistrer le MÊME appareil
   * avec les MÊMES clés renvoie l'existant (le navigateur peut retenter sans risque).
   *
   * @throws ResponseStatusException 409 si le deviceId appartient à un autre utilisateur, est
   *     révoqué, ou porte d'autres clés ; 400 si les clés sont invalides ; 409 si plafond atteint.
   */
  @Transactional
  public DeviceKeyDTO register(String email, DeviceKeyRegisterRequest req) {
    User user = currentUser(email);

    Optional<DeviceKey> existing = devices.findByDeviceId(req.deviceId());
    if (existing.isPresent()) {
      DeviceKey d = existing.get();
      boolean sameOwner = d.getUser().getId().equals(user.getId());
      // On compare les CLÉS, pas la signature : ECDSA est non déterministe, la même paire produit
      // une dhSig différente à chaque signature (la signature stockée reste la première, valide).
      boolean sameKeys =
          d.getSignPub().equals(req.signPub()) && d.getDhPub().equals(req.dhPub());
      if (sameOwner && sameKeys && !d.isRevoked()) {
        return toDTO(d);
      }
      // Même message dans tous les cas : ne révèle pas si l'id est pris par quelqu'un d'autre.
      throw new ResponseStatusException(
          HttpStatus.CONFLICT, "Identifiant d'appareil indisponible : régénérer l'appareil");
    }

    if (!DeviceKeyVerifier.isValid(req.signPub(), req.dhPub(), req.dhSig())) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Clés d'appareil invalides");
    }
    if (devices.countByUser_IdAndRevokedAtIsNull(user.getId()) >= MAX_ACTIVE_DEVICES) {
      throw new ResponseStatusException(
          HttpStatus.CONFLICT, "Trop d'appareils actifs : révoquez-en un depuis « Mes appareils »");
    }

    DeviceKey saved =
        devices.save(
            DeviceKey.builder()
                .user(user)
                .deviceId(req.deviceId())
                .label(req.label())
                .signPub(req.signPub())
                .dhPub(req.dhPub())
                .dhSig(req.dhSig())
                .createdAt(LocalDateTime.now())
                .build());
    events.publishEvent(
        new DeviceKeyEvents.Registered(user.getEmail(), saved.getLabel(), saved.getCreatedAt()));
    return toDTO(saved);
  }

  /** Appareils de l'utilisateur courant (actifs ET révoqués, les plus récents d'abord). */
  @Transactional(readOnly = true)
  public List<DeviceKeyDTO> myDevices(String email) {
    return devices.findByUser_EmailOrderByCreatedAtDesc(email).stream().map(this::toDTO).toList();
  }

  /** Révoque un appareil de l'utilisateur courant. 404 si absent OU appartenant à un autre. */
  @Transactional
  public void revoke(String email, UUID deviceId) {
    DeviceKey d =
        devices
            .findByDeviceId(deviceId)
            .filter(k -> Objects.equals(k.getUser().getEmail(), email))
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Appareil introuvable"));
    if (!d.isRevoked()) {
      d.setRevokedAt(LocalDateTime.now());
      events.publishEvent(new DeviceKeyEvents.Revoked(d.getUser().getId(), d.getDeviceId()));
    }
  }

  /**
   * Clés publiques d'un appareil (révoqué inclus : le client doit voir la révocation). L'accès
   * (partager un programme avec le propriétaire) est tranché en amont par le permission-service.
   */
  @Transactional(readOnly = true)
  public DeviceKeyDTO get(UUID deviceId) {
    return devices
        .findByDeviceId(deviceId)
        .map(this::toDTO)
        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Appareil introuvable"));
  }

  /**
   * Usage INTERNE (voice-service) : l'appareil existe, est actif ET appartient à `email`.
   *
   * @return le propriétaire, ou vide sinon (sans distinguer les cas : pas de fuite d'information)
   */
  @Transactional(readOnly = true)
  public Optional<DeviceOwnerDTO> activeOwner(UUID deviceId, String email) {
    return devices
        .findByDeviceId(deviceId)
        .filter(d -> !d.isRevoked())
        .filter(d -> Objects.equals(d.getUser().getEmail(), email))
        .map(d -> new DeviceOwnerDTO(d.getUser().getId(), d.getUser().getUsername()));
  }

  private User currentUser(String email) {
    if (email == null || email.isBlank()) {
      throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentification requise");
    }
    return users
        .findByEmail(email)
        .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Utilisateur inconnu"));
  }

  private DeviceKeyDTO toDTO(DeviceKey d) {
    return new DeviceKeyDTO(
        d.getDeviceId(),
        d.getUser().getId(),
        d.getUser().getUsername(),
        d.getLabel(),
        d.getSignPub(),
        d.getDhPub(),
        d.getDhSig(),
        d.getCreatedAt(),
        d.getRevokedAt());
  }
}
