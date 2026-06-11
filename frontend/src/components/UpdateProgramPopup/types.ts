/** Types de données et de libellés du UpdateProgramPopup. */
import { type Program } from '../../types/domain.ts';

/** Valeur synchrone ou asynchrone : le callback d'enregistrement peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/** Colonnes éditables d'un programme (dérivées de l'entité Program). */
export type ProgramData = Pick<Program, 'name' | 'code' | 'cohort' | 'color'>;
/** Modification de programme : mêmes colonnes éditables. */
export type ProgramUpdate = ProgramData;

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface UpdateProgramPopupLabels {
  /** Titre du panneau. */
  title: string;
  /** Description sous le titre. */
  subtitle: string;
  /** Libellé de la palette de couleurs. */
  colorLabel: string;
  /** Libellé accessible du bouton d'ajout de couleur. */
  addColorLabel: string;
  /** Libellé du champ « code ». */
  codeLabel: string;
  /** Invite du champ « code ». */
  codePlaceholder: string;
  /** Erreur affichée quand le code existe déjà dans l'établissement. */
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
  /** Bouton « enregistrer ». */
  save: string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Message d'erreur quand l'enregistrement échoue. */
  saveError: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
}
