package com.moodit.voice_service.moderation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.voice_service.livekit.LiveKitRoomAdmin;
import com.moodit.voice_service.livekit.LiveKitRoomAdmin.Participant;
import com.moodit.voice_service.livekit.LiveKitRoomAdmin.Room;
import com.moodit.voice_service.livekit.LiveKitRoomAdmin.Track;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Moderation vocale : etat dans les metadonnees du salon, action sur TOUS les appareils. */
class VoiceModerationServiceTest {

  private static final String ROOM = "channel:11";

  private LiveKitRoomAdmin livekit;
  private VoiceModerationService service;

  @BeforeEach
  void setUp() {
    livekit = mock(LiveKitRoomAdmin.class);
    service = new VoiceModerationService(livekit);
  }

  private static Participant device(String identity, Track... tracks) {
    return new Participant(identity, List.of(tracks));
  }

  private void roomWithMetadata(String metadata) {
    when(livekit.room(ROOM)).thenReturn(Optional.of(new Room(ROOM, metadata)));
  }

  @Test
  void serverMuteRecordsUserAndMutesEveryDeviceOfThatUserOnly() {
    roomWithMetadata("");
    when(livekit.listParticipants(ROOM))
        .thenReturn(
            List.of(
                device("7.aaa", new Track("TR_mic1", "MICROPHONE", false)),
                device("7.bbb", new Track("TR_mic2", "MICROPHONE", false), new Track("TR_cam", "CAMERA", false)),
                // 71 commence par "7" mais n'est PAS l'utilisateur 7 : le "." du prefixe compte.
                device("71.ccc", new Track("TR_mic3", "MICROPHONE", false))));

    service.serverMute(ROOM, 7);

    verify(livekit).updateRoomMetadata(ROOM, "{\"serverMuted\":[7]}");
    verify(livekit).updatePublishSources(ROOM, "7.aaa", VoiceModerationService.SOURCES_WITHOUT_MIC);
    verify(livekit).updatePublishSources(ROOM, "7.bbb", VoiceModerationService.SOURCES_WITHOUT_MIC);
    verify(livekit).mutePublishedTrack(ROOM, "7.aaa", "TR_mic1");
    verify(livekit).mutePublishedTrack(ROOM, "7.bbb", "TR_mic2");
    // La camera n'est pas touchee ; l'autre utilisateur non plus.
    verify(livekit, never()).mutePublishedTrack(ROOM, "7.bbb", "TR_cam");
    verify(livekit, never()).updatePublishSources(eq(ROOM), eq("71.ccc"), any());
    verify(livekit, never()).mutePublishedTrack(eq(ROOM), eq("71.ccc"), anyString());
  }

  @Test
  void serverMuteKeepsOtherMutedUsersAndIsIdempotent() {
    roomWithMetadata("{\"serverMuted\":[3,7]}");
    when(livekit.listParticipants(ROOM)).thenReturn(List.of(device("7.aaa")));

    service.serverMute(ROOM, 7);

    // Deja present : pas de reecriture de la metadonnee, mais la permission est re-appliquee.
    verify(livekit, never()).updateRoomMetadata(anyString(), anyString());
    verify(livekit).updatePublishSources(ROOM, "7.aaa", VoiceModerationService.SOURCES_WITHOUT_MIC);
  }

  @Test
  void serverMuteOfAbsentUserIsRefusedWithoutSideEffect() {
    when(livekit.listParticipants(ROOM)).thenReturn(List.of(device("3.xyz")));

    assertThatThrownBy(() -> service.serverMute(ROOM, 7))
        .isInstanceOf(VoiceModerationService.NotInRoomException.class);
    verify(livekit, never()).updateRoomMetadata(anyString(), anyString());
  }

  @Test
  void liftRemovesUserAndRestoresAllSourcesWithoutUnmuting() {
    roomWithMetadata("{\"serverMuted\":[3,7]}");
    when(livekit.listParticipants(ROOM)).thenReturn(List.of(device("7.aaa")));

    service.liftServerMute(ROOM, 7);

    verify(livekit).updateRoomMetadata(ROOM, "{\"serverMuted\":[3]}");
    verify(livekit).updatePublishSources(ROOM, "7.aaa", List.of());
    verify(livekit, never()).mutePublishedTrack(anyString(), anyString(), anyString());
  }

  @Test
  void liftOnClosedRoomIsNoop() {
    when(livekit.room(ROOM)).thenReturn(Optional.empty());

    service.liftServerMute(ROOM, 7);

    verify(livekit, never()).updateRoomMetadata(anyString(), anyString());
  }

  @Test
  void isServerMutedReadsRoomMetadata() {
    roomWithMetadata("{\"serverMuted\":[7]}");
    assertThat(service.isServerMuted(ROOM, 7)).isTrue();
    assertThat(service.isServerMuted(ROOM, 3)).isFalse();
  }

  @Test
  void isServerMutedToleratesGarbageAndUnreachableLiveKit() {
    roomWithMetadata("pas du json");
    assertThat(service.isServerMuted(ROOM, 7)).isFalse();

    when(livekit.room(ROOM)).thenThrow(new IllegalStateException("LiveKit down"));
    assertThat(service.isServerMuted(ROOM, 7)).isFalse();
  }

  @Test
  void kickRemovesEveryDeviceOfTheUser() {
    when(livekit.listParticipants(ROOM)).thenReturn(List.of(device("7.aaa"), device("7.bbb"), device("3.x")));
    when(livekit.removeParticipant(eq(ROOM), anyString())).thenReturn(true);

    assertThat(service.kick(ROOM, 7)).isEqualTo(2);
    verify(livekit).removeParticipant(ROOM, "7.aaa");
    verify(livekit).removeParticipant(ROOM, "7.bbb");
    verify(livekit, never()).removeParticipant(ROOM, "3.x");
  }

  @Test
  void kickOfAbsentUserIsRefused() {
    when(livekit.listParticipants(ROOM)).thenReturn(List.of());
    assertThatThrownBy(() -> service.kick(ROOM, 7))
        .isInstanceOf(VoiceModerationService.NotInRoomException.class);
  }

  @Test
  void closeRoomsDeletesOnlyActiveRooms() {
    when(livekit.listRooms(List.of("channel:1", "channel:2")))
        .thenReturn(List.of(new Room("channel:2", "")));

    assertThat(service.closeRooms(List.of("channel:1", "channel:2"))).isEqualTo(1);
    verify(livekit).deleteRoom("channel:2");
    verify(livekit, never()).deleteRoom("channel:1");
  }
}
