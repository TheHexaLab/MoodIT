// Moderation d'un salon vocal : server-mute (micro coupe ET interdit) et expulsion. Agit par
// UTILISATEUR, donc sur tous ses appareils connectes (identites LiveKit "<userId>.<deviceId>").
//
// Etat SANS BD ni memoire locale : la liste des server-mutes vit dans les METADONNEES DU SALON
// LiveKit ({"serverMuted":[7,12]}). Consequences :
//   - partagee entre instances de voice-service et survit a leur redemarrage ;
//   - visible de tous les participants (room.metadata cote SDK) → le front affiche le badge ;
//   - non modifiable par les clients (seul un jeton roomAdmin peut changer la metadonnee) ;
//   - durée de vie = celle du salon : quand il se vide et expire, les mutes disparaissent.
// Compatible E2EE : le serveur coupe/interdit une PISTE, il n'a jamais besoin de son contenu.

package com.moodit.voice_service.moderation;

import com.moodit.voice_service.livekit.LiveKitRoomAdmin;
import com.moodit.voice_service.livekit.LiveKitRoomAdmin.Participant;
import com.moodit.voice_service.livekit.LiveKitRoomAdmin.Room;
import com.moodit.voice_service.livekit.LiveKitRoomAdmin.Track;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

@Service
public class VoiceModerationService {

  private static final Logger log = LoggerFactory.getLogger(VoiceModerationService.class);

  /** Cle des metadonnees du salon : ids (User_.id) des utilisateurs server-mutes. */
  static final String MUTED_KEY = "serverMuted";

  /** Sources autorisees a un server-mute : tout SAUF le micro (camera / ecran restent permis). */
  public static final List<String> SOURCES_WITHOUT_MIC =
      List.of("CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO");

  /** Meme liste au format des grants du JoinToken (minuscules, cf. VideoGrant.canPublishSources). */
  public static final List<String> GRANT_SOURCES_WITHOUT_MIC =
      List.of("camera", "screen_share", "screen_share_audio");

  /** L'utilisateur vise n'a aucun appareil connecte dans le salon. */
  public static class NotInRoomException extends RuntimeException {
    public NotInRoomException() {
      super("Participant absent du salon vocal");
    }
  }

  private final LiveKitRoomAdmin livekit;
  private final ObjectMapper json = JsonMapper.builder().build();

  public VoiceModerationService(LiveKitRoomAdmin livekit) {
    this.livekit = livekit;
  }

  /**
   * Coupe le micro de l'utilisateur sur tous ses appareils ET lui retire le droit de le
   * republier, jusqu'a {@link #liftServerMute}. Idempotent.
   *
   * @throws NotInRoomException si l'utilisateur n'est pas connecte au salon
   */
  public synchronized void serverMute(String room, int userId) {
    List<Participant> devices = devicesOf(room, userId);
    if (devices.isEmpty()) {
      throw new NotInRoomException();
    }
    // 1. Metadonnee D'ABORD : un appareil qui (re)demande un token pendant l'operation le recoit
    //    deja sans micro.
    TreeSet<Integer> muted = mutedIn(livekit.room(room));
    if (muted.add(userId)) {
      livekit.updateRoomMetadata(room, writeMuted(muted));
    }
    for (Participant p : devices) {
      // 2. Permission : plus le droit de publier le micro (ni de le reactiver).
      livekit.updatePublishSources(room, p.identity(), SOURCES_WITHOUT_MIC);
      // 3. Coupe immediate de la piste deja publiee (filet si la version de LiveKit ne
      //    depublie pas d'elle-meme une source retiree des permissions).
      for (Track t : p.tracksOrEmpty()) {
        if (t.isMicrophone() && !t.muted()) {
          livekit.mutePublishedTrack(room, p.identity(), t.sid());
        }
      }
    }
    log.info("Server-mute : utilisateur {} dans {} ({} appareil(s))", userId, room, devices.size());
  }

  /**
   * Leve le server-mute : l'utilisateur PEUT de nouveau activer son micro (on ne le rallume pas
   * a sa place). Idempotent ; sans effet si le salon n'existe plus.
   */
  public synchronized void liftServerMute(String room, int userId) {
    Optional<Room> current = livekit.room(room);
    if (current.isEmpty()) {
      return;
    }
    TreeSet<Integer> muted = mutedIn(current);
    if (muted.remove(userId)) {
      livekit.updateRoomMetadata(room, writeMuted(muted));
    }
    for (Participant p : devicesOf(room, userId)) {
      livekit.updatePublishSources(room, p.identity(), List.of());
    }
    log.info("Server-mute leve : utilisateur {} dans {}", userId, room);
  }

  /**
   * Expulse l'utilisateur (tous ses appareils). Il peut revenir : l'expulsion n'est pas un
   * bannissement (l'acces au salon reste celui du canal texte). Un server-mute, lui, persiste.
   *
   * @return nombre d'appareils deconnectes
   * @throws NotInRoomException si l'utilisateur n'est pas connecte au salon
   */
  public int kick(String room, int userId) {
    List<Participant> devices = devicesOf(room, userId);
    if (devices.isEmpty()) {
      throw new NotInRoomException();
    }
    int removed = 0;
    for (Participant p : devices) {
      if (livekit.removeParticipant(room, p.identity())) {
        removed++;
      }
    }
    log.info("Expulsion : utilisateur {} de {} ({} appareil(s))", userId, room, removed);
    return removed;
  }

  /**
   * L'utilisateur est-il server-mute dans ce salon ? Consulte a l'emission du JoinToken (un
   * appareil qui se reconnecte ne doit pas retrouver son micro). Meilleur effort : LiveKit
   * injoignable → false (la moderation n'est pas un controle d'acces ; le join echouerait de
   * toute facon sans LiveKit).
   */
  public boolean isServerMuted(String room, int userId) {
    try {
      return mutedIn(livekit.room(room)).contains(userId);
    } catch (Exception e) {
      log.warn("Etat de moderation de {} illisible : {}", room, e.getMessage());
      return false;
    }
  }

  /** Ferme les salons (canaux supprimes). Ignore ceux qui ne sont pas actifs. */
  public int closeRooms(List<String> rooms) {
    if (rooms.isEmpty()) {
      return 0;
    }
    int closed = 0;
    for (Room r : livekit.listRooms(rooms)) {
      livekit.deleteRoom(r.name());
      closed++;
    }
    log.info("{} salon(s) vocal(aux) ferme(s) (canal supprime)", closed);
    return closed;
  }

  private List<Participant> devicesOf(String room, int userId) {
    String prefix = userId + ".";
    return livekit.listParticipants(room).stream()
        .filter(p -> p.identity() != null && p.identity().startsWith(prefix))
        .toList();
  }

  /** Lit {"serverMuted":[...]} ; metadonnee absente / illisible / autre format → vide. */
  TreeSet<Integer> mutedIn(Optional<Room> room) {
    TreeSet<Integer> ids = new TreeSet<>();
    String meta = room.map(Room::metadata).orElse(null);
    if (meta == null || meta.isBlank()) {
      return ids;
    }
    try {
      JsonNode list = json.readTree(meta).path(MUTED_KEY);
      for (JsonNode id : list) {
        if (id.canConvertToInt()) {
          ids.add(id.asInt());
        }
      }
    } catch (JacksonException e) {
      log.warn("Metadonnee de salon non JSON ignoree : {}", e.getOriginalMessage());
    }
    return ids;
  }

  String writeMuted(TreeSet<Integer> ids) {
    return json.writeValueAsString(Map.of(MUTED_KEY, ids));
  }
}
