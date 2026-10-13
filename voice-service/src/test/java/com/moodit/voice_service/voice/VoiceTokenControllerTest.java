package com.moodit.voice_service.voice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.moodit.voice_service.authz.RoomAuthorizer;
import com.moodit.voice_service.device.DeviceOwnershipClient;
import com.moodit.voice_service.device.DeviceOwnershipClient.DeviceOwner;
import com.moodit.voice_service.moderation.VoiceModerationService;
import com.moodit.voice_service.voice.dto.VoiceTokenRequest;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class VoiceTokenControllerTest {

  private static final String EMAIL = "alice@u.ca";

  private RoomAuthorizer authorizer;
  private DeviceOwnershipClient devices;
  private VoiceModerationService moderation;
  private VoiceTokenController controller;
  private UUID deviceId;

  @BeforeEach
  void setUp() {
    authorizer = mock(RoomAuthorizer.class);
    devices = mock(DeviceOwnershipClient.class);
    moderation = mock(VoiceModerationService.class);
    VoiceProperties props =
        new VoiceProperties(
            new VoiceProperties.Livekit(
                "ws://localhost:7880", "http://localhost:7880", "devkey", "dev-livekit-secret-change-me-32bytes-min"),
            60);
    controller =
        new VoiceTokenController(
            authorizer, devices, new LiveKitTokenFactory(props), moderation, props);
    deviceId = UUID.randomUUID();
  }

  @Test
  void identityIsUserIdDotDeviceIdAndNameIsUsername() {
    when(authorizer.canJoin(EMAIL, "channel", 11)).thenReturn(true);
    when(devices.activeOwner(deviceId, EMAIL)).thenReturn(Optional.of(new DeviceOwner(7, "alice")));

    var res = controller.token(EMAIL, new VoiceTokenRequest(11L, deviceId)).getBody();

    assertThat(res).isNotNull();
    assertThat(res.room()).isEqualTo("channel:11");
    String payload =
        new String(
            Base64.getUrlDecoder().decode(res.token().split("\\.")[1]), StandardCharsets.UTF_8);
    assertThat(payload).contains("\"sub\":\"7." + deviceId + "\"").contains("\"name\":\"alice\"");
    assertThat(payload).doesNotContain(EMAIL);
  }

  @Test
  void unknownOrForeignDeviceIsRefused() {
    when(authorizer.canJoin(EMAIL, "channel", 11)).thenReturn(true);
    when(devices.activeOwner(deviceId, EMAIL)).thenReturn(Optional.empty());

    assertThatThrownBy(() -> controller.token(EMAIL, new VoiceTokenRequest(11L, deviceId)))
        .isInstanceOfSatisfying(
            ResponseStatusException.class,
            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
  }

  @Test
  void channelAccessIsCheckedBeforeDevice() {
    when(authorizer.canJoin(EMAIL, "channel", 11)).thenReturn(false);

    assertThatThrownBy(() -> controller.token(EMAIL, new VoiceTokenRequest(11L, deviceId)))
        .isInstanceOfSatisfying(
            ResponseStatusException.class,
            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
  }

  @Test
  void serverMutedUserGetsTokenWithoutMicrophone() {
    when(authorizer.canJoin(EMAIL, "channel", 11)).thenReturn(true);
    when(devices.activeOwner(deviceId, EMAIL)).thenReturn(Optional.of(new DeviceOwner(7, "alice")));
    when(moderation.isServerMuted("channel:11", 7)).thenReturn(true);

    var res = controller.token(EMAIL, new VoiceTokenRequest(11L, deviceId)).getBody();

    assertThat(res).isNotNull();
    assertThat(res.serverMuted()).isTrue();
    assertThat(payload(res.token()))
        .contains("\"canPublishSources\":[\"camera\",\"screen_share\",\"screen_share_audio\"]")
        // Data channel toujours ouvert : l'echange de cles E2EE en depend.
        .contains("\"canPublishData\":true");
  }

  @Test
  void regularUserMayPublishEverySource() {
    when(authorizer.canJoin(EMAIL, "channel", 11)).thenReturn(true);
    when(devices.activeOwner(deviceId, EMAIL)).thenReturn(Optional.of(new DeviceOwner(7, "alice")));

    var res = controller.token(EMAIL, new VoiceTokenRequest(11L, deviceId)).getBody();

    assertThat(res).isNotNull();
    assertThat(res.serverMuted()).isFalse();
    assertThat(res.userId()).isEqualTo(7);
    assertThat(payload(res.token())).doesNotContain("canPublishSources");
  }

  @Test
  void canModerateReflectsModerationScope() {
    when(authorizer.canJoin(EMAIL, "channel", 11)).thenReturn(true);
    when(authorizer.canJoin(EMAIL, "voiceModerate", 11)).thenReturn(true);
    when(devices.activeOwner(deviceId, EMAIL)).thenReturn(Optional.of(new DeviceOwner(7, "alice")));

    var res = controller.token(EMAIL, new VoiceTokenRequest(11L, deviceId)).getBody();

    assertThat(res).isNotNull();
    assertThat(res.canModerate()).isTrue();
  }

  private static String payload(String jwt) {
    return new String(Base64.getUrlDecoder().decode(jwt.split("\\.")[1]), StandardCharsets.UTF_8);
  }
}
