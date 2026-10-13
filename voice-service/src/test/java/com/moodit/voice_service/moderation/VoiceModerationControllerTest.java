package com.moodit.voice_service.moderation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.voice_service.authz.RoomAuthorizer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Le controleur re-verifie le droit de moderation (scope voiceModerate) AVANT toute action. */
class VoiceModerationControllerTest {

  private static final String EMAIL = "prof@u.ca";

  private RoomAuthorizer authorizer;
  private VoiceModerationService moderation;
  private VoiceModerationController controller;

  @BeforeEach
  void setUp() {
    authorizer = mock(RoomAuthorizer.class);
    moderation = mock(VoiceModerationService.class);
    controller = new VoiceModerationController(authorizer, moderation);
  }

  @Test
  void moderatorCanMuteUnmuteAndKick() {
    when(authorizer.canJoin(EMAIL, "voiceModerate", 11)).thenReturn(true);
    when(moderation.kick("channel:11", 7)).thenReturn(2);

    assertThat(controller.mute(EMAIL, 11, 7).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
    assertThat(controller.unmute(EMAIL, 11, 7).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
    assertThat(controller.kick(EMAIL, 11, 7).getBody()).containsEntry("removedDevices", 2);

    verify(moderation).serverMute("channel:11", 7);
    verify(moderation).liftServerMute("channel:11", 7);
  }

  @Test
  void nonModeratorIsRefusedBeforeAnyAction() {
    when(authorizer.canJoin(EMAIL, "voiceModerate", 11)).thenReturn(false);

    assertThatThrownBy(() -> controller.mute(EMAIL, 11, 7))
        .isInstanceOfSatisfying(
            ResponseStatusException.class,
            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    assertThatThrownBy(() -> controller.kick(EMAIL, 11, 7))
        .isInstanceOf(ResponseStatusException.class);
    verifyNoInteractions(moderation);
  }

  @Test
  void missingIdentityIsUnauthorized() {
    assertThatThrownBy(() -> controller.unmute(null, 11, 7))
        .isInstanceOfSatisfying(
            ResponseStatusException.class,
            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));
    verifyNoInteractions(authorizer, moderation);
  }
}
