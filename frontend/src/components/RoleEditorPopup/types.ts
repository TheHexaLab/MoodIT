/** Types de données et de libellés du RoleEditorPopup. */

/** Valeur synchrone ou asynchrone : le callback d'assignation peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/** Reflète la table `Role` (id = celui inséré dans init.sql). */
export interface Role {
  id: number;
  name: string;
}

/**
 * Reflète la table `User_` + ses assignations `User_Role`.
 * `role_ids` = rôles assignés à l'utilisateur (many-to-many, comme en base).
 */
export interface User {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  email: string;
  avatar_color: string;
  role_ids: number[];
}

/**
 * Décrit une modification d'assignation rôle ↔ utilisateur (reflète un INSERT/DELETE dans User_Role).
 * Émise via onChange.
 */
export type RoleChange =
  | { type: 'assign'; roleId: number; userId: number }
  | { type: 'unassign'; roleId: number; userId: number };

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface RoleEditorPopupLabels {
  /** Titre du panneau. */
  title: string;
  /** Description sous le titre. */
  subtitle: string;
  /** Libellé du bouton d'ajout de chaque section. */
  addButton: string;
  /** Texte d'invite du champ de recherche. */
  searchPlaceholder: string;
  /** Message affiché quand une section n'a aucun utilisateur. */
  emptyRole: string;
  /** Message affiché quand aucun rôle n'est fourni. */
  emptyRoles: string;
  /** Message du sélecteur quand aucun utilisateur n'est assignable. */
  noCandidates: string;
  /** Message du sélecteur quand la recherche ne renvoie rien. */
  noResults: string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Message d'erreur quand l'enregistrement d'une assignation échoue. */
  saveError: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
}
