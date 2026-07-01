/** Types de données et de libellés du RoleEditorPopup. */
import { type Role, type User as DomainUser } from '../../types/domain.ts';

/** Valeur synchrone ou asynchrone : le callback d'assignation peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

// Entité Role ré-exportée depuis le modèle de domaine (source unique).
export type { Role };

/**
 * Utilisateur AVEC ses assignations de rôles (`User_` + `User_Role`). Dérive de
 * l'entité User ; `email`/`avatarColor` sont requis dans cette vue (membres affichés).
 */
export type User = DomainUser & {
  email: string;
  avatarColor: string;
  role_ids: number[];
};

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
