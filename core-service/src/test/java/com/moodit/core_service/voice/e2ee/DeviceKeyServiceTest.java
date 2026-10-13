package com.moodit.core_service.voice.e2ee;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.core_service.model.User;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.voice.e2ee.dto.DeviceKeyRegisterRequest;
import java.time.LocalDateTime;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

@ExtendWith(MockitoExtension.class)
class DeviceKeyServiceTest {

  // Vecteur WebCrypto valide (cf. DeviceKeyVerifierTest).
  private static final String SIGN_PUB =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgEPwC5GCI6cTrUIeFNUsnhAo4qCyX21S3JC8bXV+WvwKaN0VcEknA4Nz958Hd6Roizq8ePGn5FcmeF6OLXlR2g==";
  private static final String DH_PUB =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE3PidRDhQT7BctXVbkGKmU7QkR1iNr8AVVX4n/aalGD+cvUHb7qefEivrXdHm9+TK8p6589WpawO6vStcCFX5rA==";
  private static final String DH_SIG =
      "t3YO48zDpbtdSOKjIAEt2yjogOdEiHQ49KGFaWBhjJJN1H5xmYruzx+qxZafjZaK7irrsFdVEaBiiw0E0KWFRg==";

  @Mock private DeviceKeyRepository devices;
  @Mock private UserRepository users;
  @Mock private ApplicationEventPublisher events;
  @InjectMocks private DeviceKeyService service;

  private User alice;
  private User bob;
  private UUID deviceId;

  @BeforeEach
  void setUp() {
    alice = User.builder().id(1).username("alice").email("alice@u.ca").build();
    bob = User.builder().id(2).username("bob").email("bob@u.ca").build();
    deviceId = UUID.randomUUID();
  }

  private DeviceKeyRegisterRequest request() {
    return new DeviceKeyRegisterRequest(deviceId, "Edge · Windows", SIGN_PUB, DH_PUB, DH_SIG);
  }

  private DeviceKey stored(User owner) {
    return DeviceKey.builder()
        .user(owner)
        .deviceId(deviceId)
        .signPub(SIGN_PUB)
        .dhPub(DH_PUB)
        .dhSig(DH_SIG)
        .createdAt(LocalDateTime.now())
        .build();
  }

  @Test
  void registersNewDevice() {
    when(users.findByEmail("alice@u.ca")).thenReturn(Optional.of(alice));
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.empty());
    when(devices.save(any())).thenAnswer(inv -> inv.getArgument(0));

    var dto = service.register("alice@u.ca", request());

    assertThat(dto.deviceId()).isEqualTo(deviceId);
    assertThat(dto.userId()).isEqualTo(1);
    assertThat(dto.revokedAt()).isNull();
    // Nouvel appareil → email « nouvel appareil » (après commit, via DeviceKeyNotifier).
    verify(events).publishEvent(any(DeviceKeyEvents.Registered.class));
  }

  @Test
  void reRegisteringSameDeviceIsIdempotent() {
    when(users.findByEmail("alice@u.ca")).thenReturn(Optional.of(alice));
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.of(stored(alice)));

    assertThat(service.register("alice@u.ca", request()).deviceId()).isEqualTo(deviceId);
    verify(devices, never()).save(any());
    verify(events, never()).publishEvent(any());
  }

  @Test
  void reRegisteringWithAFreshSignatureOfTheSameKeysIsIdempotent() {
    // ECDSA est non déterministe : le navigateur peut re-signer les mêmes clés (autre dhSig).
    when(users.findByEmail("alice@u.ca")).thenReturn(Optional.of(alice));
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.of(stored(alice)));
    var resigned = new DeviceKeyRegisterRequest(deviceId, null, SIGN_PUB, DH_PUB, "AAAA" + DH_SIG);

    assertThat(service.register("alice@u.ca", resigned).deviceId()).isEqualTo(deviceId);
    verify(devices, never()).save(any());
  }

  @Test
  void deviceIdOfAnotherUserIsRejected() {
    when(users.findByEmail("bob@u.ca")).thenReturn(Optional.of(bob));
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.of(stored(alice)));

    assertThatThrownBy(() -> service.register("bob@u.ca", request()))
        .isInstanceOfSatisfying(
            ResponseStatusException.class,
            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
  }

  @Test
  void revokedDeviceCannotBeReRegistered() {
    DeviceKey revoked = stored(alice);
    revoked.setRevokedAt(LocalDateTime.now());
    when(users.findByEmail("alice@u.ca")).thenReturn(Optional.of(alice));
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.of(revoked));

    assertThatThrownBy(() -> service.register("alice@u.ca", request()))
        .isInstanceOf(ResponseStatusException.class);
  }

  @Test
  void invalidKeysAreRejected() {
    when(users.findByEmail("alice@u.ca")).thenReturn(Optional.of(alice));
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.empty());
    var bad = new DeviceKeyRegisterRequest(deviceId, null, DH_PUB, SIGN_PUB, DH_SIG);

    assertThatThrownBy(() -> service.register("alice@u.ca", bad))
        .isInstanceOfSatisfying(
            ResponseStatusException.class,
            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
    verify(devices, never()).save(any());
  }

  @Test
  void deviceCapIsEnforced() {
    when(users.findByEmail("alice@u.ca")).thenReturn(Optional.of(alice));
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.empty());
    when(devices.countByUser_IdAndRevokedAtIsNull(1))
        .thenReturn((long) DeviceKeyService.MAX_ACTIVE_DEVICES);

    assertThatThrownBy(() -> service.register("alice@u.ca", request()))
        .isInstanceOf(ResponseStatusException.class);
  }

  @Test
  void cannotRevokeSomeoneElsesDevice() {
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.of(stored(alice)));

    assertThatThrownBy(() -> service.revoke("bob@u.ca", deviceId))
        .isInstanceOfSatisfying(
            ResponseStatusException.class,
            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
  }

  @Test
  void activeOwnerOnlyForOwnerAndNotRevoked() {
    DeviceKey d = stored(alice);
    when(devices.findByDeviceId(deviceId)).thenReturn(Optional.of(d));

    assertThat(service.activeOwner(deviceId, "alice@u.ca")).hasValueSatisfying(o -> {
      assertThat(o.userId()).isEqualTo(1);
      assertThat(o.username()).isEqualTo("alice");
    });
    assertThat(service.activeOwner(deviceId, "bob@u.ca")).isEmpty();

    service.revoke("alice@u.ca", deviceId);
    assertThat(service.activeOwner(deviceId, "alice@u.ca")).isEmpty();

    // Révocation → UNE éjection, même si on révoque une seconde fois.
    service.revoke("alice@u.ca", deviceId);
    verify(events).publishEvent(new DeviceKeyEvents.Revoked(1, deviceId));
  }
}
