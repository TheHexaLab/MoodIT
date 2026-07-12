/**
 * Noms des rôles (table Role) référencés dans la logique de permissions. Source UNIQUE côté
 * front : évite les littéraux dupliqués (un renommage ne casse plus le code silencieusement).
 * Doit rester aligné avec les seeds d'init.sql ET les constantes backend (model/RoleNames.java).
 */
export const ROLE = {
  /** Enseignant : gère le contenu d'un programme (cours, canaux, quiz, forums). */
  TEACHER: 'Enseignant',
  /** Administrateur : de programme (tout sauf supprimer) OU global (admin plateforme). */
  ADMIN: 'Administrateur',
  /** Gardien : super-admin plateforme, au-dessus d'Administrateur (User_Role uniquement). */
  GUARDIAN: 'Gardien',
} as const;

/** Nom de rôle affichable dans une permission (programme ou global). */
export type RoleName = (typeof ROLE)[keyof typeof ROLE];

/** Rôle possible d'un utilisateur DANS un programme (User_Program_Role) : Administrateur ou Enseignant. */
export type ProgramRoleName = typeof ROLE.ADMIN | typeof ROLE.TEACHER;
