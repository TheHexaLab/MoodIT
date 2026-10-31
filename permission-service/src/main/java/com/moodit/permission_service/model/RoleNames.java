package com.moodit.permission_service.model;

/**
 * Noms canoniques des rôles (colonne Role.name, données de référence de db/migration), en un seul endroit. Les prédicats
 * d'autorisation comparent par NOM (pas par id) — utiliser ces constantes évite les fautes de
 * frappe silencieuses (ex. "Administration" ≠ "Administrateur" ne matcherait jamais → règle morte).
 */
public final class RoleNames {

  private RoleNames() {}

  /** Rôle PROGRAMME : gère le contenu d'un cours de son programme. */
  public static final String TEACHER = "Enseignant";

  /** Rôle GLOBAL (plateforme) OU PROGRAMME : administration complète. */
  public static final String ADMIN = "Administrateur";

  /** Rôle GLOBAL uniquement : super-administrateur (gère les administrateurs). */
  public static final String GUARDIAN = "Gardien";
}
