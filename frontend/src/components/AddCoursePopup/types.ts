/** Types de données et de libellés du AddCoursePopup. */
import { type Program } from '../../types/domain.ts';

/** Valeur synchrone ou asynchrone : le callback de sauvegarde peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

// Entité Program ré-exportée depuis le modèle de domaine (source unique).
export type { Program };

/**
 * DTO de création de cours (write) : colonnes saisissables de `Course` + les
 * liens `program_course`. Dérive de l'entité Course.
 */
export interface NewCourse {
  title: string;
  code: string;
  programIds: number[];
}

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface AddCoursePopupLabels {
  /** Titre du panneau. */
  title: string;
  /** Description sous le titre. */
  subtitle: string;
  /** Libellé du champ des programmes. */
  programsLabel: string;
  /** Invite affichée dans le champ quand aucun programme n'est sélectionné. */
  programsPlaceholder: string;
  /** Invite du champ de recherche du menu. */
  searchPlaceholder: string;
  /** Message du menu quand aucun programme n'est disponible. */
  noCandidates: string;
  /** Message du menu quand la recherche ne renvoie rien. */
  noResults: string;
  /** Libellé du champ « code ». */
  codeLabel: string;
  /** Invite du champ « code ». */
  codePlaceholder: string;
  /** Libellé du champ « titre ». */
  titleLabel: string;
  /** Invite du champ « titre ». */
  titlePlaceholder: string;
  /** Bouton « annuler ». */
  cancel: string;
  /** Bouton « sauvegarder ». */
  save: string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Message d'erreur quand l'enregistrement échoue. */
  saveError: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
}
