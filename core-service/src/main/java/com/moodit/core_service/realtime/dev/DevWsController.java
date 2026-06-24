// Outil de DEV (profil `dev` uniquement) : déclenche manuellement des diffusions
// temps réel, en attendant que les vrais contrôleurs REST appellent
// RealtimeEventPublisher après persistance. Permet de voir un message / sujet /
// cours / programme apparaître LIVE dans le Dashboard sans backend métier.
//
// ⚠ N'existe PAS hors profil `dev` (jamais exposé en prod). À appeler directement
// sur core-service (ex. http://localhost:8081/dev/ws/...), pas via le gateway.
// Reste à la racine (pas sous /api) : WebMvcConfig exclut le package `realtime`
// du préfixe /api appliqué aux contrôleurs REST.
//
// Exemples :
//   curl -X POST "http://localhost:8081/dev/ws/message?channelId=5&content=Coucou"
//   curl -X POST "http://localhost:8081/dev/ws/post?forumId=9&content=Nouveau%20sujet"
//   curl -X POST "http://localhost:8081/dev/ws/course?programId=1&title=Cours%20WS"
//   curl -X POST "http://localhost:8081/dev/ws/program?userId=1&name=Programme%20WS"

package com.moodit.core_service.realtime.dev;

import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.Author;
import com.moodit.core_service.realtime.dto.ChannelMessageDto;
import com.moodit.core_service.realtime.dto.CourseDto;
import com.moodit.core_service.realtime.dto.ForumPostDto;
import com.moodit.core_service.realtime.dto.ProgramDto;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Profile("dev")
@RequestMapping("/dev/ws")
public class DevWsController {

  /** Ids « serveur » simulés, démarrés haut pour ne pas heurter les vrais ids. */
  private final AtomicLong seq = new AtomicLong(9000);

  /** Auteur fictif des éléments simulés (rosie, présente dans init.sql). */
  private static final Author ROSIE = new Author(2, "rosie1234", "Rosie", "HG", "#0a5cc0");

  /**
   * Id de l'utilisateur de TEST : room `user:<id>` ciblée par défaut pour les
   * diffusions « programme » (subscription / update / delete). UNIQUE endroit à
   * changer pour tester avec un autre compte — le front s'abonne à
   * `user:<currentUser.id>`, donc connecte-toi avec CET id.
   * (String car requis comme `defaultValue` d'annotation, qui doit être constant.)
   */
  private static final String MOCK_REALTIME_USER_ID = "4";

  private final RealtimeEventPublisher publisher;

  public DevWsController(RealtimeEventPublisher publisher) {
    this.publisher = publisher;
  }

  /** Simule un message reçu dans un canal de chat ('Discussion'). */
  @PostMapping("/message")
  public String message(
      @RequestParam(defaultValue = "1") long channelId,
      @RequestParam(defaultValue = "(dev) message temps réel 👋") String content) {
    long id = seq.incrementAndGet();
    publisher.messageCreated(
        channelId,
        new ChannelMessageDto(id, content, Instant.now().toString(), ROSIE, null, null));
    return "message #" + id + " diffusé sur channel:" + channelId;
  }

  /** Simule un nouveau sujet racine dans un forum ('Thread'). */
  @PostMapping("/post")
  public String post(
      @RequestParam(defaultValue = "3") long forumId,
      @RequestParam(defaultValue = "(dev) sujet temps réel 👋") String content,
      @RequestParam(required = false) String title) {
    long id = seq.incrementAndGet();
    ForumPostDto p =
        new ForumPostDto(
            id,
            content,
            Instant.now().toString(),
            ROSIE,
            false,
            title,
            List.of(),
            List.of(),
            0,
            null);
    publisher.postCreated(forumId, p, null);
    return "post #" + id + " diffusé sur forum:" + forumId;
  }

  /** Simule l'ajout d'un cours dans un programme. */
  @PostMapping("/course")
  public String course(
      @RequestParam(defaultValue = "1") long programId,
      @RequestParam(defaultValue = "Cours temps réel") String title) {
    long id = seq.incrementAndGet();
    publisher.courseCreated(programId, CourseDto.of(id, "WS-" + id, title));
    return "course #" + id + " diffusé sur program:" + programId;
  }

  /** Simule l'adhésion / l'ajout d'un programme pour un utilisateur. */
  @PostMapping("/program")
  public String program(
      @RequestParam(defaultValue = MOCK_REALTIME_USER_ID) long userId,
      @RequestParam(defaultValue = "Programme temps réel") String name) {
    long id = seq.incrementAndGet();
    publisher.subscriptionAdded(
        userId, new ProgramDto(id, name, "WS" + id, "WS", "#7c3aed"));
    return "program #" + id + " diffusé sur user:" + userId;
  }

  // ─── Modifications / suppressions (PATCH / DELETE) ──────────────────────────
  // L'id ciblé doit EXISTER dans la room ouverte côté front. Défauts choisis sur
  // les données mock : channel 1 → messages 1..7 ; forum 3 → sujets 101/102/106/120.

  /** Simule la modification distante d'un message du canal. */
  @PatchMapping("/message")
  public String editMessage(
      @RequestParam(defaultValue = "1") long channelId,
      @RequestParam(defaultValue = "1") long messageId,
      @RequestParam(defaultValue = "(dev) message modifié ✏️") String content) {
    publisher.messageEdited(channelId, messageId, content);
    return "message #" + messageId + " modifié sur channel:" + channelId;
  }

  /** Simule la suppression distante d'un message du canal. */
  @DeleteMapping("/message")
  public String deleteMessage(
      @RequestParam(defaultValue = "1") long channelId,
      @RequestParam(defaultValue = "1") long messageId) {
    publisher.messageDeleted(channelId, messageId);
    return "message #" + messageId + " supprimé sur channel:" + channelId;
  }

  /** Simule la modification distante d'un sujet / d'une réponse du forum. */
  @PatchMapping("/post")
  public String editPost(
      @RequestParam(defaultValue = "3") long forumId,
      @RequestParam(defaultValue = "102") long postId,
      @RequestParam(defaultValue = "(dev) sujet modifié ✏️") String content) {
    publisher.postEdited(forumId, postId, content);
    return "post #" + postId + " modifié sur forum:" + forumId;
  }

  /** Simule la suppression distante d'un sujet / d'une réponse du forum. */
  @DeleteMapping("/post")
  public String deletePost(
      @RequestParam(defaultValue = "3") long forumId,
      @RequestParam(defaultValue = "102") long postId) {
    publisher.postDeleted(forumId, postId);
    return "post #" + postId + " supprimé sur forum:" + forumId;
  }

  // ─── Cours : modification / suppression (scope = programme actif) ────────────
  // Room = program:<programId> : le programme doit être SÉLECTIONNÉ dans le front.
  // Défaut mock : programme 1 (Génie informatique) → cours 1/2/3.
  // NB : course:edited REMPLACE le cours (les sections du DTO font foi) ; le défaut
  // cible le cours 1 (sans sections) pour un test propre.

  /** Simule la modification distante d'un cours (titre / code). */
  @PatchMapping("/course")
  public String editCourse(
      @RequestParam(defaultValue = "1") long programId,
      @RequestParam(defaultValue = "1") long courseId,
      @RequestParam(defaultValue = "GIF123") String code,
      @RequestParam(defaultValue = "Cours modifié ✏️") String title) {
    publisher.courseEdited(programId, CourseDto.of(courseId, code, title));
    return "course #" + courseId + " modifié sur program:" + programId;
  }

  /** Simule la suppression distante d'un cours. */
  @DeleteMapping("/course")
  public String deleteCourse(
      @RequestParam(defaultValue = "1") long programId,
      @RequestParam(defaultValue = "1") long courseId) {
    publisher.courseDeleted(programId, courseId);
    return "course #" + courseId + " supprimé sur program:" + programId;
  }

  // ─── Programme : modification / suppression (scope = utilisateur) ────────────
  // Room = user:<userId> (le Dashboard s'abonne avec userId=1). Défaut programId=2
  // (Génie électrique) pour ne pas perturber le programme 1 souvent actif.

  /** Simule la modification distante d'un programme (nom / code / cohorte / couleur). */
  @PatchMapping("/program")
  public String editProgram(
      @RequestParam(defaultValue = MOCK_REALTIME_USER_ID) long userId,
      @RequestParam(defaultValue = "2") long programId,
      @RequestParam(defaultValue = "Programme modifié ✏️") String name,
      @RequestParam(defaultValue = "GEL") String code,
      @RequestParam(defaultValue = "71") String cohort,
      @RequestParam(defaultValue = "#8b1a1a") String color) {
    publisher.programUpdated(userId, new ProgramDto(programId, name, code, cohort, color));
    return "program #" + programId + " modifié sur user:" + userId;
  }

  /** Simule la suppression / le désabonnement distant d'un programme. */
  @DeleteMapping("/program")
  public String deleteProgram(
      @RequestParam(defaultValue = MOCK_REALTIME_USER_ID) long userId,
      @RequestParam(defaultValue = "2") long programId) {
    publisher.programDeleted(userId, programId);
    return "program #" + programId + " supprimé sur user:" + userId;
  }
}
