// Client minimal de l'API SERVEUR LiveKit (protocole Twirp : POST JSON sur
// /twirp/livekit.RoomService/<Methode>, authentifie par un jeton admin court). Sert a ejecter
// immediatement un appareil revoque de tous les salons ou il est connecte (voice-service/E2EE.md
// §8). Pas de SDK serveur LiveKit : trois appels HTTP suffisent, zero dependance.

package com.moodit.voice_service.livekit;

import com.moodit.voice_service.voice.LiveKitTokenFactory;
import com.moodit.voice_service.voice.VoiceProperties;
import java.util.List;
import java.util.Map;
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

  record Room(String name) {}

  record ListRoomsResponse(List<Room> rooms) {}

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
    ListRoomsResponse list =
        call("ListRooms", null, Map.of(), ListRoomsResponse.class);
    int removed = 0;
    for (Room room : list == null || list.rooms() == null ? List.<Room>of() : list.rooms()) {
      try {
        call("RemoveParticipant", room.name(), Map.of("room", room.name(), "identity", identity), Map.class);
        removed++;
      } catch (HttpClientErrorException.NotFound e) {
        // Pas dans ce salon : cas normal.
      }
    }
    log.info("Appareil {} retire de {} salon(s) vocal(aux)", identity, removed);
    return removed;
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
