// Client minimal de l'API SERVEUR LiveKit (protocole Twirp : POST JSON sur
// /twirp/livekit.RoomService/<Methode>, authentifie par un jeton admin court). Sert a :
//   - ejecter immediatement un appareil revoque de tous les salons (voice-service/E2EE.md §8) ;
//   - la MODERATION (server-mute, expulsion) et la fermeture d'un salon dont le canal est supprime.
// Pas de SDK serveur LiveKit : quelques appels HTTP suffisent, zero dependance.

package com.moodit.voice_service.livekit;

import com.moodit.voice_service.voice.LiveKitTokenFactory;
import com.moodit.voice_service.voice.VoiceProperties;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

@Component
public class LiveKitRoomAdmin {

  private static final Logger log = LoggerFactory.getLogger(LiveKitRoomAdmin.class);
  private static final String SERVICE = "/twirp/livekit.RoomService/";

  /** Salon actif. metadata : chaine libre posee par le serveur (cf. VoiceModerationService). */
  public record Room(String name, String metadata) {}

  record ListRoomsResponse(List<Room> rooms) {}

  /** Piste publiee. source : enum LiveKit TrackSource ("MICROPHONE", "CAMERA"...). */
  public record Track(String sid, String source, boolean muted) {

    public boolean isMicrophone() {
      // Twirp/protojson emet le NOM de l'enum ; on accepte aussi la valeur numerique (2).
      return "MICROPHONE".equalsIgnoreCase(source) || "2".equals(source);
    }
  }

  public record Participant(String identity, List<Track> tracks) {

    public List<Track> tracksOrEmpty() {
      return tracks == null ? List.of() : tracks;
    }
  }

  record ListParticipantsResponse(List<Participant> participants) {}

  private final RestClient http;
  private final LiveKitTokenFactory tokens;

  public LiveKitRoomAdmin(VoiceProperties props, LiveKitTokenFactory tokens) {
    this.http = RestClient.builder().baseUrl(props.livekit().apiUrl() + SERVICE).build();
    this.tokens = tokens;
  }

  /**
   * Retire `identity` de TOUS les salons actifs ou il est connecte.
   *
   * @return nombre de salons dont il a ete retire
   */
  public int removeEverywhere(String identity) {
    int removed = 0;
    for (Room room : listRooms(List.of())) {
      if (removeParticipant(room.name(), identity)) {
        removed++;
      }
    }
    log.info("Appareil {} retire de {} salon(s) vocal(aux)", identity, removed);
    return removed;
  }

  /**
   * Salons actifs. names vide = tous ; sinon seulement ceux-la (les absents sont ignores par
   * LiveKit : un salon n'existe que tant que quelqu'un y est, ou pendant son empty_timeout).
   */
  public List<Room> listRooms(List<String> names) {
    Map<String, Object> body = names.isEmpty() ? Map.of() : Map.of("names", names);
    ListRoomsResponse list = call("ListRooms", null, body, ListRoomsResponse.class);
    return list == null || list.rooms() == null ? List.of() : list.rooms();
  }

  /** Le salon s'il est actif. */
  public Optional<Room> room(String room) {
    return listRooms(List.of(room)).stream().filter(r -> room.equals(r.name())).findFirst();
  }

  /** Participants connectes (vide si le salon n'existe pas). */
  public List<Participant> listParticipants(String room) {
    try {
      ListParticipantsResponse res =
          call("ListParticipants", room, Map.of("room", room), ListParticipantsResponse.class);
      return res == null || res.participants() == null ? List.of() : res.participants();
    } catch (HttpClientErrorException.NotFound e) {
      return List.of();
    }
  }

  /** @return false si le participant (ou le salon) n'existe pas */
  public boolean removeParticipant(String room, String identity) {
    try {
      call("RemoveParticipant", room, Map.of("room", room, "identity", identity), Map.class);
      return true;
    } catch (HttpClientErrorException.NotFound e) {
      return false;
    }
  }

  /** Coupe (cote serveur) une piste publiee. LiveKit previent tout le salon (TrackMuted). */
  public void mutePublishedTrack(String room, String identity, String trackSid) {
    call(
        "MutePublishedTrack",
        room,
        Map.of("room", room, "identity", identity, "track_sid", trackSid, "muted", true),
        Map.class);
  }

  /**
   * Remplace les permissions d'un participant connecte. sources vide = toutes les sources
   * autorisees ; sinon seulement celles listees (enum TrackSource : "CAMERA", "SCREEN_SHARE"...).
   * Le data channel reste TOUJOURS ouvert : l'echange de cles E2EE en depend.
   */
  public void updatePublishSources(String room, String identity, List<String> sources) {
    Map<String, Object> permission = new HashMap<>();
    permission.put("can_subscribe", true);
    permission.put("can_publish", true);
    permission.put("can_publish_data", true);
    permission.put("can_publish_sources", sources);
    call(
        "UpdateParticipant",
        room,
        Map.of("room", room, "identity", identity, "permission", permission),
        Map.class);
  }

  /** Metadonnees du salon (visibles de tous les participants, modifiables par le serveur seul). */
  public void updateRoomMetadata(String room, String metadata) {
    call("UpdateRoomMetadata", room, Map.of("room", room, "metadata", metadata), Map.class);
  }

  /** Ferme le salon : tous les participants sont deconnectes. */
  public void deleteRoom(String room) {
    try {
      call("DeleteRoom", room, Map.of("room", room), Map.class);
    } catch (HttpClientErrorException.NotFound e) {
      // Deja ferme : cas normal.
    }
  }

  private <T> T call(String method, String room, Map<String, ?> body, Class<T> type) {
    return http.post()
        .uri(method)
        .header("Authorization", "Bearer " + tokens.createAdminToken(room))
        .contentType(MediaType.APPLICATION_JSON)
        .body(body)
        .retrieve()
        .body(type);
  }
}
