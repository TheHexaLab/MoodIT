// Autorisation RÉELLE des rooms (active hors profil `dev`). Vérifie en BD, via
// JdbcTemplate, que l'utilisateur a le droit de rejoindre la room demandée :
//   user:<id>    → c'est SA propre room (id == son user_id)
//   program:<id> → il est abonné au programme (User_Program)
//   channel/forum:<id> → le Forum appartient à un cours d'un programme auquel il
//                        est abonné (Forum → program_course → User_Program)
//
// N'utilise pas (encore) le modèle JPA : requêtes SQL directes sur le schéma
// d'init.sql, pour être opérationnel sans dépendre des entités à venir. Les colleg.
// pourront remplacer cette impl par une version repository sans toucher au handler.
//
// Actif dans TOUS les profils (dev compris) : la vérification d'appartenance
// s'applique partout. ⚠ En dev, le front doit donc joindre des rooms réelles
// (user:<vrai id>, ids de canaux/forums existants) et l'utilisateur doit être
// abonné, sinon le `join` est refusé.

package com.moodit.core_service.realtime;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
public class DbRoomAuthorizer implements RoomAuthorizer {

  private final JdbcTemplate jdbc;

  public DbRoomAuthorizer(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  public boolean canJoin(String email, String scope, long id) {
    if (email == null || email.isBlank()) {
      return false;
    }
    Long userId = userIdByEmail(email);
    if (userId == null) {
      return false;
    }
    return switch (scope) {
      case "user" -> id == userId;
      case "program" -> isSubscribedToProgram(userId, id);
      case "channel", "forum" -> canSeeForum(userId, id);
      default -> false;
    };
  }

  /** Renvoie l'id de l'utilisateur pour cet email, ou null s'il n'existe pas. */
  private Long userIdByEmail(String email) {
    return jdbc.query(
        "SELECT id FROM User_ WHERE email = ?",
        rs -> rs.next() ? rs.getLong(1) : null,
        email);
  }

  private boolean isSubscribedToProgram(long userId, long programId) {
    return Boolean.TRUE.equals(
        jdbc.queryForObject(
            "SELECT EXISTS(SELECT 1 FROM User_Program WHERE user_id = ? AND program_id = ?)",
            Boolean.class,
            userId,
            programId));
  }

  /**
   * Un canal / forum (Forum.id) est visible si son cours appartient à un programme
   * auquel l'utilisateur est abonné. (Si l'inscription directe au cours doit aussi
   * compter, ajouter un OR sur Enrollment(user_id, course_id).)
   */
  private boolean canSeeForum(long userId, long forumId) {
    return Boolean.TRUE.equals(
        jdbc.queryForObject(
            """
            SELECT EXISTS(
              SELECT 1
              FROM Forum f
              JOIN program_course pc ON pc.course_id = f.course_id
              JOIN User_Program up   ON up.program_id = pc.program_id
              WHERE f.id = ? AND up.user_id = ?
            )
            """,
            Boolean.class,
            forumId,
            userId));
  }
}
