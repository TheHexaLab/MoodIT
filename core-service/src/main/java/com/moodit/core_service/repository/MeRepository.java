// Lecture de l'utilisateur via JdbcTemplate sur le schéma d'init.sql (table User_).
// Même approche que DbRoomAuthorizer : SQL direct, sans dépendre des entités JPA à
// venir. Les collègues pourront remplacer cette impl par un repository JPA sans
// toucher au contrôleur.

package com.moodit.core_service.repository;

import com.moodit.core_service.dto.MeDto;
import com.moodit.core_service.dto.Role;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class MeRepository {

  private final JdbcTemplate jdbc;

  public MeRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  // Profil sans les rôles : ceux-ci sont une relation 1‑N (User_Role), chargés à part
  // puis assemblés dans le MeDto final (cf. withRoles).
  private static final RowMapper<MeDto> ME_MAPPER =
      (rs, rowNum) ->
          new MeDto(
              rs.getLong("id"),
              rs.getString("username"),
              rs.getString("first_name"),
              rs.getString("last_name"),
              rs.getString("email"),
              rs.getString("avatar_color"),
              List.of(),
              rs.getString("settings"));

  private static final RowMapper<Role> ROLE_MAPPER =
      (rs, rowNum) -> new Role(rs.getLong("id"), rs.getString("name"));

  /** Profil de l'utilisateur (rôles globaux inclus) pour cet email, ou vide s'il n'existe pas. */
  public Optional<MeDto> findByEmail(String email) {
    return jdbc
        .query(
            """
            SELECT id, username, first_name, last_name, email, avatar_color, settings
            FROM User_
            WHERE email = ?
            """,
            ME_MAPPER,
            email)
        .stream()
        .findFirst()
        .map(this::withRoles);
  }

  /**
   * Met à jour les champs de profil modifiables et renvoie le profil à jour (rôles inclus). Vide si
   * aucun utilisateur ne correspond à cet email. RETURNING évite un second SELECT pour le profil ;
   * les rôles sont chargés ensuite.
   */
  public Optional<MeDto> updateByEmail(
      String email, String firstName, String lastName, String avatarColor) {
    return jdbc
        .query(
            """
            UPDATE User_
            SET first_name = ?, last_name = ?, avatar_color = ?
            WHERE email = ?
            RETURNING id, username, first_name, last_name, email, avatar_color, settings
            """,
            ME_MAPPER,
            firstName,
            lastName,
            avatarColor,
            email)
        .stream()
        .findFirst()
        .map(this::withRoles);
  }

  /**
   * Écrase le blob de préférences (colonne TEXT `settings`) de l'utilisateur et renvoie le profil à
   * jour (rôles inclus). Vide si aucun utilisateur ne correspond à cet email. Le contenu est un JSON
   * opaque validé côté contrôleur — le repository ne l'interprète pas.
   */
  public Optional<MeDto> updateSettingsByEmail(String email, String settingsJson) {
    return jdbc
        .query(
            """
            UPDATE User_
            SET settings = ?
            WHERE email = ?
            RETURNING id, username, first_name, last_name, email, avatar_color, settings
            """,
            ME_MAPPER,
            settingsJson,
            email)
        .stream()
        .findFirst()
        .map(this::withRoles);
  }

  /** Complète un profil (rôles vides) avec ses rôles globaux (table User_Role). */
  private MeDto withRoles(MeDto base) {
    return new MeDto(
        base.id(),
        base.username(),
        base.firstName(),
        base.lastName(),
        base.email(),
        base.avatarColor(),
        rolesByUserId(base.id()),
        base.settings());
  }

  /** Rôles globaux de l'utilisateur (User_Role → Role), triés par id. */
  private List<Role> rolesByUserId(long userId) {
    return jdbc.query(
        """
        SELECT r.id, r.name
        FROM Role r
        JOIN User_Role ur ON ur.role_id = r.id
        WHERE ur.user_id = ?
        ORDER BY r.id
        """,
        ROLE_MAPPER,
        userId);
  }
}
