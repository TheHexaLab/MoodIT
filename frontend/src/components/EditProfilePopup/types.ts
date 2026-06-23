/** Types de données et de libellés du EditProfilePopup. */
import { type User } from '../../types/domain.ts';

/** Valeur synchrone ou asynchrone : le callback d'enregistrement peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/** Utilisateur édité : sous-ensemble de l'entité User (colonnes affichées/éditables). */
export type ProfileUser = Pick<
  User,
  'username' | 'firstName' | 'lastName' | 'avatarColor' | 'avatarUrl'
>;

/** Modification de profil (reflète les colonnes éditables de `User_`). */
export interface ProfileUpdate {
  firstName: string;
  lastName: string;
  avatarColor: string;
  /** Photo : `File` = nouvelle photo à téléverser, `null` = retirée, `undefined` = inchangée. */
  photo?: File | null;
}

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface EditProfilePopupLabels {
  /** Titre du panneau. */
  title: string;
  /** Description sous le titre. */
  subtitle: string;
  /** Libellé de la section avatar. */
  avatarLabel: string;
  /** Libellé au-dessus de la palette de couleurs. */
  paletteLabel: string;
  /** Libellé accessible du bouton d'ajout de couleur. */
  addColorLabel: string;
  /** Libellé du bouton de retrait de la photo. */
  removePhoto: string;
  /** Libellé du champ « prénom ». */
  firstNameLabel: string;
  /** Invite du champ « prénom ». */
  firstNamePlaceholder: string;
  /** Libellé du champ « nom ». */
  lastNameLabel: string;
  /** Invite du champ « nom ». */
  lastNamePlaceholder: string;
  /** Bouton « annuler ». */
  cancel: string;
  /** Bouton « enregistrer ». */
  save: string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Message d'erreur quand l'enregistrement échoue. */
  saveError: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
}
