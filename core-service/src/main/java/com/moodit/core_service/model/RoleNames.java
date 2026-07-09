package com.moodit.core_service.model;

/**
 * Noms des rôles (table Role) référencés dans la logique métier. Source UNIQUE côté backend :
 * évite les littéraux dupliqués dans les services (un renommage ne casse plus le code silencieusement).
 * Doit rester aligné avec les seeds d'init.sql ET les constantes du front (frontend/src/helpers/roles.ts).
 */
public final class RoleNames {

  /** Enseignant : gère le contenu d'un programme (cours, canaux, quiz, forums). */
  public static final String TEACHER = "Enseignant";

  /** Administrateur : de programme (tout sauf supprimer) OU global (admin plateforme). */
  public static final String ADMIN = "Administrateur";

  /** Gardien : super-admin plateforme, au-dessus d'Administrateur (User_Role uniquement). */
  public static final String GUARDIAN = "Gardien";

  private RoleNames() {}
}
