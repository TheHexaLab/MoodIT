/** Types de données et de libellés du AddSubscriptionPopup. */
import { type Establishment, type Program } from '../../types/domain.ts';

/** Valeur synchrone ou asynchrone : les callbacks de chargement peuvent retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

// Entités ré-exportées depuis le modèle de domaine (source unique).
export type { Establishment, Program };

/**
 * Établissement + les codes de ses programmes existants (dérivé de Establishment).
 * Chargé au clic « Créer un programme » : alimente le dropdown et l'unicité du code.
 */
export type CreateEstablishment = Establishment & { programCodes: string[] };

/**
 * Établissement + son nombre de programmes (dérivé de Establishment).
 * Chargé au clic « Rejoindre un programme » : alimente la liste et la désactivation des lignes vides.
 */
export type JoinEstablishment = Establishment & { programCount: number };

/**
 * DTO de création de programme (write) : colonnes saisissables de `Program` +
 * l'établissement choisi (null tant que non sélectionné dans le formulaire).
 */
export type NewProgram = Pick<Program, 'name' | 'code' | 'cohort' | 'color'> & {
  establishmentId: number | null;
};

/** Sélection émise par la vue « rejoindre » : un établissement + des programmes. */
export interface JoinSelection {
  establishmentId: number;
  programIds: number[];
}

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface AddSubscriptionPopupLabels {
  /** Titre du panneau (vue menu). */
  title: string;
  /** Description sous le titre (vue menu). */
  subtitle: string;
  /** Titre de l'option « créer » / du formulaire. */
  createTitle: string;
  /** Description de l'option « créer » / du formulaire. */
  createSubtitle: string;
  /** Titre de l'option « rejoindre » (et de la vue). */
  joinTitle: string;
  /** Description de l'option « rejoindre » (menu). */
  joinSubtitle: string;
  /** Titre de l'option « gérer les établissements » (menu, réservée aux gardiens). */
  manageEstablishmentsTitle: string;
  /** Description de l'option « gérer les établissements » (menu). */
  manageEstablishmentsSubtitle: string;
  /** Sous-titre de l'étape recherche d'établissement (vue rejoindre). */
  joinSearchSubtitle: string;
  /** Sous-titre de l'étape sélection des programmes (vue rejoindre). */
  joinProgramsSubtitle: string;
  /** Invite de la barre de recherche des programmes (vue rejoindre). */
  programSearchPlaceholder: string;
  /** Message quand l'établissement n'a aucun programme. */
  noPrograms: string;
  /** Décompte de programmes affiché sous le nom de l'établissement (reçoit le nombre). */
  programCount: (count: number) => string;
  /** Bouton « ajouter » (vue rejoindre). */
  add: string;
  /** Libellé accessible du bouton « retour ». */
  back: string;
  /** Libellé de la palette de couleurs. */
  colorLabel: string;
  /** Libellé accessible du bouton d'ajout de couleur. */
  addColorLabel: string;
  /** Libellé du champ « établissement ». */
  establishmentLabel: string;
  /** Invite du champ « établissement » quand rien n'est sélectionné. */
  establishmentPlaceholder: string;
  /** Invite de la barre de recherche du menu établissement. */
  searchPlaceholder: string;
  /** Message du menu établissement quand aucun n'est disponible. */
  noEstablishments: string;
  /** Message du menu établissement quand la recherche ne renvoie rien. */
  noResults: string;
  /** Libellé du champ « code ». */
  codeLabel: string;
  /** Invite du champ « code ». */
  codePlaceholder: string;
  /** Erreur affichée quand le code existe déjà dans l'établissement choisi. */
  codeTaken: string;
  /** Libellé du champ « nom ». */
  nameLabel: string;
  /** Invite du champ « nom ». */
  namePlaceholder: string;
  /** Libellé du champ « cohorte ». */
  cohortLabel: string;
  /** Invite du champ « cohorte ». */
  cohortPlaceholder: string;
  /** Bouton « annuler ». */
  cancel: string;
  /** Bouton « créer ». */
  submit: string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Message d'erreur quand un chargement de données échoue. */
  loadError: string;
  /** Message d'erreur quand l'enregistrement (création / adhésion) échoue. */
  saveError: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
}
